import { getNeed } from '../catalog/needs';
import type { CabinLink } from '../cabin/link';
import type { CrewToPassenger, DeviceKind } from '../cabin/protocol';
import type {
  AccessibilityPrefs,
  Announcement,
  LinkStatus,
  MedicalReport,
  NeedPurpose,
  PassengerProfile,
  PassengerRequest,
  RequestSource,
  Understanding,
} from '../types';

/**
 * PassengerSession: the shared, framework-free core of both passenger apps.
 *
 * Delivery rules (never claim delivery without confirmation):
 *  - A new request is `pending` until the crew tablet sends `request.received`.
 *  - With no cabin connection it stays `pending` (waiting) and is sent when the
 *    connection returns; after `offlineFailAfterMs` it becomes `failed`.
 *  - When online, each attempt waits `ackTimeoutMs` for confirmation, retrying
 *    with backoff up to `maxAttempts`, then `failed`.
 *  - A crew reply moves it to `acknowledged` (a reply also proves receipt).
 */

export interface SessionOptions {
  ackTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  offlineFailAfterMs: number;
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  ackTimeoutMs: 4000,
  maxAttempts: 3,
  retryBaseMs: 1000,
  offlineFailAfterMs: 60_000,
};

export const DEFAULT_PREFS: AccessibilityPrefs = {
  textScale: 1,
  highContrast: false,
  replyChannels: ['text', 'voice', 'buzz'],
  reduceMotion: false,
};

export interface SessionState {
  profile: PassengerProfile | null;
  prefs: AccessibilityPrefs;
  requests: PassengerRequest[];
  announcements: Announcement[];
  link: LinkStatus;
  /** Request whose crew reply should be shown prominently (reply overlay). */
  replyToShow: string | null;
  /** Newest announcement not yet seen (caption toast). */
  unseenAnnouncement: string | null;
}

export interface PersistedSession {
  profile: PassengerProfile | null;
  prefs: AccessibilityPrefs;
  requests: PassengerRequest[];
  announcements: Announcement[];
}

export type SubmitResult =
  | { ok: true; request: PassengerRequest }
  | { ok: false; reason: 'no_profile' | 'unknown_need' | 'duplicate' };

export interface SessionDeps {
  link: CabinLink;
  device: DeviceKind;
  options?: Partial<SessionOptions>;
  now?: () => number;
  idFactory?: () => string;
}

const ACTIVE: PassengerRequest['status'][] = ['pending', 'sent', 'acknowledged'];

export function isActive(r: PassengerRequest): boolean {
  return ACTIVE.includes(r.status);
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export class PassengerSession {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubs: (() => void)[] = [];
  private readonly opts: SessionOptions;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  readonly device: DeviceKind;

  constructor(private deps: SessionDeps) {
    this.opts = { ...DEFAULT_SESSION_OPTIONS, ...deps.options };
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.idFactory ?? randomId;
    this.device = deps.device;
    this.state = {
      profile: null,
      prefs: DEFAULT_PREFS,
      requests: [],
      announcements: [],
      link: deps.link.getStatus(),
      replyToShow: null,
      unseenAnnouncement: null,
    };
    this.unsubs.push(deps.link.onStatus((s) => this.onLinkStatus(s)));
    this.unsubs.push(deps.link.onMessage((m) => this.onMessage(m)));
  }

  // ── Store plumbing ──────────────────────────────────────────────────────
  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SessionState>): void {
    const seatBefore = this.state.profile?.seat;
    this.state = { ...this.state, ...patch };
    const seatAfter = this.state.profile?.seat;
    if (seatBefore !== seatAfter) this.deps.link.setSeat?.(seatAfter);
    this.listeners.forEach((l) => l());
  }

  private patchRequest(id: string, patch: Partial<PassengerRequest>): void {
    this.set({
      requests: this.state.requests.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: this.now() } : r)),
    });
  }

  private find(id: string): PassengerRequest | undefined {
    return this.state.requests.find((r) => r.id === id);
  }

  // ── Profile & preferences ───────────────────────────────────────────────
  setProfile(profile: PassengerProfile): void {
    this.set({ profile });
  }

  updateProfile(patch: Partial<PassengerProfile>): void {
    if (!this.state.profile) return;
    this.set({ profile: { ...this.state.profile, ...patch } });
  }

  setPrefs(patch: Partial<AccessibilityPrefs>): void {
    this.set({ prefs: { ...this.state.prefs, ...patch } });
  }

  // ── Requests ────────────────────────────────────────────────────────────
  submit(input: {
    needId: string;
    purposeId?: NeedPurpose['id'];
    source: RequestSource;
    understanding?: Understanding;
    medical?: MedicalReport;
  }): SubmitResult {
    if (!this.state.profile) return { ok: false, reason: 'no_profile' };
    const need = getNeed(input.needId);
    if (!need) return { ok: false, reason: 'unknown_need' };
    const purposeId = input.purposeId && need.purposes?.includes(input.purposeId) ? input.purposeId : undefined;
    const open = this.state.requests.find(
      (r) => r.needId === input.needId && (r.status === 'pending' || r.status === 'sent'),
    );
    if (open) return { ok: false, reason: 'duplicate' };

    const t = this.now();
    const request: PassengerRequest = {
      id: this.idFactory(),
      needId: need.id,
      purposeId,
      source: input.source,
      createdAt: t,
      updatedAt: t,
      status: 'pending',
      attempts: 0,
      waitingForConnection: false,
      ...(input.understanding && input.source !== 'tap' ? { understanding: input.understanding } : {}),
      ...(input.medical ? { medical: input.medical } : {}),
    };
    this.set({ requests: [request, ...this.state.requests] });
    this.attempt(request.id);
    return { ok: true, request: this.find(request.id)! };
  }

  retry(id: string): void {
    const r = this.find(id);
    if (!r || r.status !== 'failed') return;
    this.patchRequest(id, { status: 'pending', attempts: 0, failureReason: undefined, waitingForConnection: false });
    this.attempt(id);
  }

  cancel(id: string): void {
    const r = this.find(id);
    if (!r || !isActive(r) || !this.state.profile) return;
    this.clearTimers(id);
    this.deps.link.send({ type: 'request.cancel', requestId: id, seat: this.state.profile.seat });
    this.patchRequest(id, { status: 'cancelled', waitingForConnection: false });
    if (this.state.replyToShow === id) this.set({ replyToShow: null });
  }

  thank(id: string): void {
    const r = this.find(id);
    if (!r || r.status !== 'acknowledged' || !this.state.profile) return;
    this.deps.link.send({ type: 'request.thanks', requestId: id, seat: this.state.profile.seat });
    this.patchRequest(id, { status: 'closed' });
    if (this.state.replyToShow === id) this.set({ replyToShow: null });
  }

  dismissReply(): void {
    this.set({ replyToShow: null });
  }

  markAnnouncementsSeen(): void {
    if (this.state.unseenAnnouncement) this.set({ unseenAnnouncement: null });
  }

  /** Remove closed/cancelled requests from the list. */
  clearFinished(): void {
    this.set({ requests: this.state.requests.filter((r) => r.status !== 'closed' && r.status !== 'cancelled') });
  }

  // ── Session lifecycle ───────────────────────────────────────────────────
  /** Restore a persisted session (mobile only). Pending requests resume delivery. */
  hydrate(saved: PersistedSession): void {
    this.set({ profile: saved.profile, prefs: { ...DEFAULT_PREFS, ...saved.prefs }, requests: saved.requests, announcements: saved.announcements });
    for (const r of saved.requests) if (r.status === 'pending') this.attempt(r.id);
  }

  snapshot(): PersistedSession {
    const { profile, prefs, requests, announcements } = this.state;
    return { profile, prefs, requests, announcements };
  }

  /**
   * End the session and forget everything (IFE "End session", mobile "Clear my data").
   * Open requests are withdrawn so the crew is not left waiting on a passenger who left.
   */
  clear(): void {
    for (const r of this.state.requests) if (isActive(r)) this.cancel(r.id);
    for (const id of [...this.ackTimers.keys(), ...this.retryTimers.keys(), ...this.offlineTimers.keys()]) this.clearTimers(id);
    this.set({
      profile: null,
      prefs: DEFAULT_PREFS,
      requests: [],
      announcements: [],
      replyToShow: null,
      unseenAnnouncement: null,
    });
  }

  dispose(): void {
    for (const id of [...this.ackTimers.keys(), ...this.retryTimers.keys(), ...this.offlineTimers.keys()]) this.clearTimers(id);
    this.unsubs.forEach((u) => u());
    this.listeners.clear();
  }

  // ── Delivery ────────────────────────────────────────────────────────────
  private attempt(id: string): void {
    const r = this.find(id);
    const profile = this.state.profile;
    if (!r || r.status !== 'pending' || !profile) return;

    if (this.deps.link.getStatus() === 'offline') {
      this.patchRequest(id, { waitingForConnection: true });
      if (!this.offlineTimers.has(id)) {
        this.offlineTimers.set(
          id,
          setTimeout(() => {
            this.offlineTimers.delete(id);
            const cur = this.find(id);
            if (cur?.status === 'pending') this.fail(id, 'no_connection');
          }, this.opts.offlineFailAfterMs),
        );
      }
      return;
    }

    this.clearTimer(this.offlineTimers, id);
    const attempts = r.attempts + 1;
    this.patchRequest(id, { attempts, waitingForConnection: false });
    const left = this.deps.link.send({
      type: 'request.create',
      requestId: id,
      seat: profile.seat,
      device: this.device,
      lang: profile.lang,
      needId: r.needId,
      purposeId: r.purposeId,
      source: r.source,
      tags: profile.shareTagsWithCrew ? profile.tags : [],
      createdAt: r.createdAt,
      ...(r.understanding ? { understanding: r.understanding } : {}),
      ...(r.medical ? { medical: r.medical } : {}),
      ...(profile.speechLang ? { spokenLang: profile.speechLang } : {}),
    });
    if (!left) {
      // Connection dropped between the status check and sending: wait for it instead.
      this.patchRequest(id, { attempts: r.attempts });
      if (this.deps.link.getStatus() === 'offline') this.attempt(id);
      else this.fail(id, 'no_connection');
      return;
    }

    this.clearTimer(this.ackTimers, id);
    this.ackTimers.set(
      id,
      setTimeout(() => {
        this.ackTimers.delete(id);
        const cur = this.find(id);
        if (cur?.status !== 'pending') return;
        if (cur.attempts >= this.opts.maxAttempts) {
          this.fail(id, 'no_confirmation');
          return;
        }
        const backoff = this.opts.retryBaseMs * 2 ** (cur.attempts - 1);
        this.retryTimers.set(
          id,
          setTimeout(() => {
            this.retryTimers.delete(id);
            this.attempt(id);
          }, backoff),
        );
      }, this.opts.ackTimeoutMs),
    );
  }

  private fail(id: string, reason: PassengerRequest['failureReason']): void {
    this.clearTimers(id);
    this.patchRequest(id, { status: 'failed', failureReason: reason, waitingForConnection: false });
  }

  private onLinkStatus(status: LinkStatus): void {
    const wasOffline = this.state.link === 'offline';
    this.set({ link: status });
    if (wasOffline && status !== 'offline') {
      for (const r of this.state.requests) if (r.status === 'pending' && r.waitingForConnection) this.attempt(r.id);
    }
  }

  private onMessage(m: CrewToPassenger): void {
    if (m.type === 'announcement') {
      if (this.state.announcements.some((a) => a.id === m.id)) return;
      if (!this.state.profile) return; // nobody is using this device yet
      this.set({
        announcements: [{ id: m.id, templateId: m.templateId, at: m.at }, ...this.state.announcements].slice(0, 30),
        unseenAnnouncement: m.id,
      });
      return;
    }
    if (m.type === 'crew.heartbeat') return;
    const profile = this.state.profile;
    if (!profile || m.seat !== profile.seat) return;
    const r = this.find(m.requestId);
    if (!r) return;

    if (m.type === 'request.received') {
      if (r.status !== 'pending') return;
      this.clearTimers(r.id);
      this.patchRequest(r.id, { status: 'sent', sentAt: this.now(), waitingForConnection: false });
    } else if (m.type === 'request.reply') {
      if (r.status !== 'pending' && r.status !== 'sent' && r.status !== 'acknowledged') return;
      this.clearTimers(r.id);
      this.patchRequest(r.id, {
        status: 'acknowledged',
        sentAt: r.sentAt ?? this.now(),
        waitingForConnection: false,
        reply: { ...(m.replyId ? { replyId: m.replyId } : {}), ...(m.message ? { message: m.message } : {}), crewName: m.crewName, at: m.at },
      });
      this.set({ replyToShow: r.id });
    }
  }

  private clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, id: string): void {
    const t = map.get(id);
    if (t) clearTimeout(t);
    map.delete(id);
  }

  private clearTimers(id: string): void {
    this.clearTimer(this.ackTimers, id);
    this.clearTimer(this.retryTimers, id);
    this.clearTimer(this.offlineTimers, id);
  }
}
