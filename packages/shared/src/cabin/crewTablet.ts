import { getNeed } from '../catalog/needs';
import type { CrewMessage, LangCode, MedicalReport, NeedPurpose, ProfileTag, ReplyId, RequestSource, Understanding } from '../types';
import type { CabinBus } from './bus';
import type { CabinMessage, DeviceKind } from './protocol';

/**
 * The crew tablet's request list and one-tap replies.
 *
 * The same model runs in three places:
 *  - inside the cabin hub (`apps/hub`): the real crew tablet service that every
 *    phone, seatback screen and crew console on the cabin Wi-Fi shares
 *  - inside a passenger app as an auto-responding stand-in when there is no hub
 *  - behind a crew console tab in the same browser (BroadcastChannel)
 */

export interface CrewRequest {
  requestId: string;
  seat: string;
  device: DeviceKind;
  lang: LangCode;
  needId: string;
  purposeId?: NeedPurpose['id'];
  source: RequestSource;
  tags: ProfileTag[];
  createdAt: number;
  receivedAt: number;
  status: 'new' | 'replied' | 'cancelled' | 'thanked';
  reply?: { replyId?: ReplyId; message?: CrewMessage; at: number };
  understanding?: Understanding;
  medical?: MedicalReport;
  spokenLang?: string;
}

export interface CrewAnnouncementLog {
  id: string;
  templateId: string;
  at: number;
}

export interface CrewTabletState {
  requests: CrewRequest[];
  announcements: CrewAnnouncementLog[];
  autoReply: boolean;
}

export interface CrewTabletOptions {
  crewName?: string;
  autoReply?: boolean;
  autoReplyDelayMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

/** What a crew console needs from a crew tablet, wherever it runs (here, or in the hub). */
export interface CrewTabletApi {
  /** True when the state lives in the cabin hub (shared by every crew device). */
  readonly remote: boolean;
  getState(): CrewTabletState;
  subscribe(listener: (s: CrewTabletState) => void): () => void;
  reply(requestId: string, replyId: ReplyId): void;
  /** The crew member's own words, machine-translated: shown to the passenger as such. */
  sendMessage(requestId: string, message: CrewMessage): void;
  announce(templateId: string): void;
  setAutoReply(autoReply: boolean): void;
  /** Clear all requests and captions (demo reset). */
  reset(): void;
  dispose(): void;
}

/** The reply a crew member would most likely tap for a need. */
export function defaultReplyFor(needId: string): ReplyId {
  const need = getNeed(needId);
  if (needId === 'wheelchair_arrival') return 'ground_informed';
  if (!need || need.private || need.category === 'help') return 'coming_to_seat';
  return 'bringing_now';
}

export class CrewTablet implements CrewTabletApi {
  readonly remote = false;
  private state: CrewTabletState;
  private listeners = new Set<(s: CrewTabletState) => void>();
  private unsubscribe: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pendingAuto = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly crewName: string;
  private readonly autoReplyDelayMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private bus: CabinBus,
    options: CrewTabletOptions = {},
  ) {
    this.crewName = options.crewName ?? 'Aoi';
    this.autoReplyDelayMs = options.autoReplyDelayMs ?? 2500;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => Math.random().toString(36).slice(2, 10));
    this.state = { requests: [], announcements: [], autoReply: options.autoReply ?? false };
    this.unsubscribe = bus.subscribe((m) => this.receive(m));
    const beat = () => this.bus.post({ type: 'crew.heartbeat', at: this.now() });
    beat();
    this.heartbeat = setInterval(beat, options.heartbeatMs ?? 2000);
  }

  getState(): CrewTabletState {
    return this.state;
  }

  subscribe(listener: (s: CrewTabletState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setAutoReply(autoReply: boolean): void {
    this.update({ ...this.state, autoReply });
  }

  reply(requestId: string, replyId: ReplyId): void {
    const req = this.state.requests.find((r) => r.requestId === requestId);
    if (!req || req.status === 'cancelled') return;
    const at = this.now();
    this.clearAuto(requestId);
    this.patch(requestId, { status: req.status === 'thanked' ? 'thanked' : 'replied', reply: { replyId, at } });
    this.bus.post({ type: 'request.reply', requestId, seat: req.seat, replyId, crewName: this.crewName, at });
  }

  sendMessage(requestId: string, message: CrewMessage): void {
    const req = this.state.requests.find((r) => r.requestId === requestId);
    if (!req || req.status === 'cancelled') return;
    const at = this.now();
    this.clearAuto(requestId);
    this.patch(requestId, { status: req.status === 'thanked' ? 'thanked' : 'replied', reply: { message, at } });
    this.bus.post({ type: 'request.reply', requestId, seat: req.seat, message, crewName: this.crewName, at });
  }

  reset(): void {
    this.pendingAuto.forEach((t) => clearTimeout(t));
    this.pendingAuto.clear();
    this.update({ ...this.state, requests: [], announcements: [] });
  }

  announce(templateId: string): void {
    const entry = { id: this.idFactory(), templateId, at: this.now() };
    this.update({ ...this.state, announcements: [entry, ...this.state.announcements].slice(0, 20) });
    this.bus.post({ type: 'announcement', ...entry });
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pendingAuto.forEach((t) => clearTimeout(t));
    this.pendingAuto.clear();
    this.unsubscribe();
    this.listeners.clear();
  }

  private receive(m: CabinMessage): void {
    switch (m.type) {
      case 'request.create': {
        const existing = this.state.requests.find((r) => r.requestId === m.requestId);
        if (!existing) {
          const { type: _type, ...rest } = m;
          const req: CrewRequest = { ...rest, receivedAt: this.now(), status: 'new' };
          this.update({ ...this.state, requests: [req, ...this.state.requests] });
          if (this.state.autoReply) this.scheduleAuto(req);
        }
        // Always confirm receipt (also for retries of a request we already have).
        this.bus.post({ type: 'request.received', requestId: m.requestId, seat: m.seat });
        if (existing?.reply) {
          this.bus.post({ type: 'request.reply', requestId: m.requestId, seat: m.seat, ...existing.reply, crewName: this.crewName });
        }
        break;
      }
      case 'request.cancel':
        this.clearAuto(m.requestId);
        this.patch(m.requestId, { status: 'cancelled' });
        break;
      case 'request.thanks':
        this.patch(m.requestId, { status: 'thanked' });
        break;
      default:
        break;
    }
  }

  private scheduleAuto(req: CrewRequest): void {
    const t = setTimeout(() => {
      this.pendingAuto.delete(req.requestId);
      const current = this.state.requests.find((r) => r.requestId === req.requestId);
      if (current?.status === 'new') this.reply(req.requestId, defaultReplyFor(req.needId));
    }, this.autoReplyDelayMs);
    this.pendingAuto.set(req.requestId, t);
  }

  private clearAuto(requestId: string): void {
    const t = this.pendingAuto.get(requestId);
    if (t) clearTimeout(t);
    this.pendingAuto.delete(requestId);
  }

  private patch(requestId: string, patch: Partial<CrewRequest>): void {
    this.update({
      ...this.state,
      requests: this.state.requests.map((r) => (r.requestId === requestId ? { ...r, ...patch } : r)),
    });
  }

  private update(next: CrewTabletState): void {
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }
}
