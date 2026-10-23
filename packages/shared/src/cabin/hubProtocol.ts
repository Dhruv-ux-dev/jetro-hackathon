import { LANGUAGES } from '../i18n/languages';
import type { BodyArea, ConditionId, CrewMessage, LangCode, MedicalReport, NeedPurpose, ProfileTag, ReplyId, SymptomId, Understanding } from '../types';
import type { CrewTabletState } from './crewTablet';
import type { CabinMessage, PassengerToCrew } from './protocol';

/**
 * Frames on the WebSocket between a device and the cabin hub (`apps/hub`).
 *
 *  - passenger: a phone or seatback screen. Sends cabin messages; receives only
 *    messages for its own seat plus announcements and crew heartbeats.
 *  - crew: a crew console. Receives the crew tablet state and sends commands.
 *  - observer: the demo stage timeline. Receives every cabin message and hub event.
 */
export type HubRole = 'passenger' | 'crew' | 'observer';

/** Commands a crew console sends to the hub's crew tablet. */
export type CrewCommand =
  | { type: 'reply'; requestId: string; replyId: ReplyId }
  | { type: 'message'; requestId: string; message: CrewMessage }
  | { type: 'announce'; templateId: string }
  | { type: 'autoReply'; on: boolean }
  | { type: 'reset' };

export type ClientFrame =
  | { kind: 'hello'; role: HubRole; seat?: string }
  | { kind: 'cabin'; msg: PassengerToCrew }
  | { kind: 'crew'; cmd: CrewCommand };

/** What the hub tells the demo stage and crew consoles (meaning only: never audio). */
export type HubEvent =
  | {
      type: 'understood';
      at: number;
      /** Who spoke: a passenger (matched to needs) or crew (matched to verified replies). */
      target: 'needs' | 'replies';
      /** One of the 6 languages, or a language-pack code such as "bn". */
      lang: string;
      transcript: string;
      /** Best match (need id or reply id) and its confidence. */
      match?: string;
      /** Several requests in one sentence, or a refusal: what will be asked for, and what was ruled out. */
      requests?: { needId: string; purposeId?: NeedPurpose['id'] }[];
      refused?: string[];
      confidence: number;
      asrMs: number;
      matchMs: number;
    }
  | {
      /** Whisper has started on a recording (shown live while the passenger waits). */
      type: 'working';
      at: number;
      target: 'needs' | 'replies';
      lang: string;
      estimateMs: number;
    };

export type ServerFrame =
  | { kind: 'cabin'; msg: CabinMessage }
  | { kind: 'crewState'; state: CrewTabletState }
  | { kind: 'event'; event: HubEvent };

/** `wss://host/ws` for a hub base URL like `https://host:8443`. */
export function hubSocketUrl(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

// ── Validation (the hub treats every frame as untrusted input) ────────────

const SEAT_RE = /^([1-9]|[1-6][0-9]|70)[A-HJK]$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANG_CODES = new Set<string>(LANGUAGES.map((l) => l.code));
const TAGS = new Set<ProfileTag>(['senior', 'hard_of_hearing', 'low_vision', 'wheelchair', 'medical', 'travelling_with_child']);
const AREAS = new Set<BodyArea>(['head', 'eyes_ears', 'throat', 'chest', 'stomach', 'back', 'arms', 'legs']);
const SYMPTOMS = new Set<SymptomId>(['dizzy', 'nausea', 'breathing', 'fever', 'allergy', 'bleeding', 'faint', 'numb']);
const CONDITIONS = new Set<ConditionId>(['diabetes', 'heart', 'asthma', 'blood_pressure', 'pregnant', 'epilepsy']);
const REPLY_IDS = new Set<ReplyId>([
  'bringing_now',
  'one_moment',
  'coming_to_seat',
  'after_seatbelt',
  'not_available',
  'ground_informed',
  'here_you_go',
  'doctor_coming',
  'stay_seated',
  'meal_soon',
  'staff_on_arrival',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
export const isSeat = (v: unknown): v is string => typeof v === 'string' && SEAT_RE.test(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

function subset<T extends string>(v: unknown, allowed: Set<T>, max = 8): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !allowed.has(x as T)) return null;
    if (!out.includes(x as T)) out.push(x as T);
  }
  return out;
}

function parseUnderstanding(v: unknown): Understanding | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v) || typeof v.confidence !== 'number' || typeof v.viaPictures !== 'boolean') return null;
  return { confidence: Math.max(0, Math.min(1, v.confidence)), viaPictures: v.viaPictures };
}

function parseMedical(v: unknown): MedicalReport | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  if (v.pain !== null && (typeof v.pain !== 'number' || !Number.isInteger(v.pain) || v.pain < 0 || v.pain > 10)) return null;
  const areas = subset(v.areas, AREAS);
  const symptoms = subset(v.symptoms, SYMPTOMS);
  const conditions = subset(v.conditions, CONDITIONS);
  if (!areas || !symptoms || !conditions) return null;
  return { areas, pain: v.pain, symptoms, conditions };
}

/** Validate a passenger → crew message. Returns a clean copy, or null if malformed. */
export function parsePassengerMessage(v: unknown): PassengerToCrew | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'request.create': {
      if (!isId(v.requestId) || !isSeat(v.seat) || (v.device !== 'phone' && v.device !== 'ife')) return null;
      if (typeof v.lang !== 'string' || !LANG_CODES.has(v.lang) || !isId(v.needId) || !isTime(v.createdAt)) return null;
      if (v.source !== 'tap' && v.source !== 'speech' && v.source !== 'typed') return null;
      const purposes = ['for_medicine', 'vegetarian', 'for_child', 'urgent'];
      if (v.purposeId !== undefined && (typeof v.purposeId !== 'string' || !purposes.includes(v.purposeId))) return null;
      const tags = subset(v.tags, TAGS);
      const understanding = parseUnderstanding(v.understanding);
      const medical = parseMedical(v.medical);
      if (!tags || understanding === null || medical === null) return null;
      if (v.spokenLang !== undefined && (typeof v.spokenLang !== 'string' || !/^[a-z]{2,3}$/.test(v.spokenLang))) return null;
      return {
        type: 'request.create',
        requestId: v.requestId,
        seat: v.seat,
        device: v.device,
        lang: v.lang as LangCode,
        needId: v.needId,
        ...(v.purposeId ? { purposeId: v.purposeId as NeedPurpose['id'] } : {}),
        source: v.source,
        tags,
        createdAt: v.createdAt,
        ...(understanding ? { understanding } : {}),
        ...(medical ? { medical } : {}),
        ...(v.spokenLang ? { spokenLang: v.spokenLang } : {}),
      };
    }
    case 'request.cancel':
    case 'request.thanks':
      if (!isId(v.requestId) || !isSeat(v.seat)) return null;
      return { type: v.type, requestId: v.requestId, seat: v.seat };
    default:
      return null;
  }
}

/** Validate a frame sent by a device to the hub. */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'hello') {
    if (raw.role !== 'passenger' && raw.role !== 'crew' && raw.role !== 'observer') return null;
    if (raw.seat !== undefined && !isSeat(raw.seat)) return null;
    return { kind: 'hello', role: raw.role, ...(raw.seat ? { seat: raw.seat as string } : {}) };
  }
  if (raw.kind === 'cabin') {
    const msg = parsePassengerMessage(raw.msg);
    return msg ? { kind: 'cabin', msg } : null;
  }
  if (raw.kind === 'crew' && isObj(raw.cmd)) {
    const c = raw.cmd;
    if (c.type === 'reply' && isId(c.requestId) && typeof c.replyId === 'string' && REPLY_IDS.has(c.replyId as ReplyId)) {
      return { kind: 'crew', cmd: { type: 'reply', requestId: c.requestId, replyId: c.replyId as ReplyId } };
    }
    if (c.type === 'message' && isId(c.requestId) && isObj(c.message)) {
      const { original, text, lang } = c.message;
      const ok = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
      if (ok(original, 300) && ok(text, 600) && ok(lang, 8)) return { kind: 'crew', cmd: { type: 'message', requestId: c.requestId, message: { original, text, lang } } };
    }
    if (c.type === 'announce' && isStr(c.templateId)) return { kind: 'crew', cmd: { type: 'announce', templateId: c.templateId } };
    if (c.type === 'autoReply' && typeof c.on === 'boolean') return { kind: 'crew', cmd: { type: 'autoReply', on: c.on } };
    if (c.type === 'reset') return { kind: 'crew', cmd: { type: 'reset' } };
  }
  return null;
}
