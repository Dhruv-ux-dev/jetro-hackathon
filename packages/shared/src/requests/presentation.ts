import { getNeed, getPurpose } from '../catalog/needs';
import { getReply } from '../catalog/replies';
import { needLabel, purposeLabel, replyTextOf } from '../i18n/resolve';
import { t, type StringKey } from '../i18n/strings';
import type { CrewMessage, LangCode, PassengerRequest, ReplyId } from '../types';

export type StatusTone = 'progress' | 'success' | 'danger' | 'neutral';

export interface StatusView {
  label: string;
  hint?: string;
  tone: StatusTone;
  /** Short machine key for icons/tests. */
  key: 'waiting' | 'sending' | 'sent' | 'acknowledged' | 'failed' | 'cancelled' | 'closed';
}

/** How a request's status is described to the passenger. Only `sent`/`acknowledged` claim delivery. */
export function describeStatus(r: PassengerRequest, lang: LangCode): StatusView {
  const tr = (k: StringKey) => t(lang, k);
  switch (r.status) {
    case 'pending':
      return r.waitingForConnection
        ? { key: 'waiting', label: tr('status.waiting'), hint: tr('status.waitingHint'), tone: 'progress' }
        : { key: 'sending', label: tr('status.pending'), hint: tr('status.pendingHint'), tone: 'progress' };
    case 'sent':
      return { key: 'sent', label: tr('status.sent'), hint: tr('status.sentHint'), tone: 'success' };
    case 'acknowledged':
      return { key: 'acknowledged', label: tr('status.acknowledged'), tone: 'success' };
    case 'failed':
      return { key: 'failed', label: tr('status.failed'), hint: tr('status.failedHint'), tone: 'danger' };
    case 'cancelled':
      return { key: 'cancelled', label: tr('status.cancelled'), tone: 'neutral' };
    case 'closed':
      return { key: 'closed', label: tr('status.closed'), tone: 'neutral' };
  }
}

/** "Hot water · to take medicine" in the given language. */
export function requestTitle(r: Pick<PassengerRequest, 'needId' | 'purposeId'>, lang: LangCode): string {
  const need = getNeed(r.needId);
  const base = need ? needLabel(need, lang) : r.needId;
  const purpose = getPurpose(r.purposeId);
  return purpose ? `${base} · ${purposeLabel(purpose, lang)}` : base;
}

export function replyText(r: PassengerRequest, lang: LangCode): string | undefined {
  return r.reply ? crewReplyText(r.reply, lang) : undefined;
}

/** What the passenger reads: the verified reply in their language, or the crew member's own words as translated. */
export function crewReplyText(reply: { replyId?: ReplyId; message?: CrewMessage } | undefined, lang: LangCode): string {
  if (reply?.message) return reply.message.text;
  return reply?.replyId ? replyTextOf(getReply(reply.replyId), lang) : '';
}

/** Relative time like "12s" / "3 min", language-neutral enough for the prototype. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}
