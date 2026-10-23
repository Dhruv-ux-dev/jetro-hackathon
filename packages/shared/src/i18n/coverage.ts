import type { StringKey } from './strings';

/**
 * The interface strings a language pack must translate before its language is
 * offered for screens. They are everything a passenger reads on the way from
 * opening the app to seeing the crew's reply: greeting, the request grid,
 * speaking, "Did you mean?", confirming, delivery status, the offline card and
 * Care Mode. `packs.test.ts` fails if a pack misses one, so a language can
 * never be offered as a screen language while half of its path is blank.
 *
 * Deliberately *not* in this list:
 *  - `safety.*` — safety briefing wording must come from airline-approved,
 *    human-checked text, so a pack is not allowed to supply it (enforced below).
 *  - settings detail, seatback-only screens, the voice check and announcement
 *    screens: they fall back to the pack's core language, which is visible to
 *    the passenger rather than silently wrong.
 */
export const PASSENGER_PATH_KEYS = [
  'app.tagline',
  'common.seat', 'common.back', 'common.cancel', 'common.continue', 'common.close', 'common.retry', 'common.offlineOk',
  'home.greeting', 'home.greetingName', 'home.question', 'home.more', 'home.private', 'home.holdToSpeak', 'home.typeInstead', 'home.activeRequest',
  'speech.listening', 'speech.tapToFinish', 'speech.processing', 'speech.sending', 'speech.queued', 'speech.secondsLeft', 'speech.almost',
  'speech.matching', 'speech.heard', 'speech.stepListen', 'speech.stepUnderstand', 'speech.stepPicture',
  'speech.didYouMean', 'speech.noneCallCrew',
  'ask.exactWords', 'ask.soundsLike', 'ask.meaning', 'ask.disagree', 'ask.weakHint', 'ask.nothing',
  'ask.sayAgain', 'ask.fixWords', 'ask.showAll', 'ask.cannotUnderstand', 'speech.typePlaceholder', 'speech.typeEmpty', 'speech.findMatch',
  'speech.micDenied', 'speech.needsHub', 'speech.private', 'speech.tooShort', 'speech.error',
  'review.title', 'review.purpose', 'review.send', 'review.privateNote', 'review.privateTitle', 'review.privateSent',
  'review.many', 'review.sendAll', 'review.notWanted',
  'status.pending', 'status.stepRequest', 'status.waiting', 'status.sent', 'status.acknowledged', 'status.failed',
  'status.cancelled', 'status.closed', 'status.pendingHint', 'status.waitingHint', 'status.sentHint', 'status.failedHint',
  'requests.title', 'requests.empty', 'requests.thanks', 'requests.cancel', 'requests.showCard', 'requests.limit',
  'reply.from', 'reply.machine', 'reply.playAgain', 'voice.mayHaveNoVoice',
  'card.title', 'card.hint',
  'nav.home', 'nav.requests', 'nav.card', 'nav.flight', 'nav.settings', 'nav.request',
  'link.online', 'link.offline', 'link.offlineHint',
  'care.open', 'care.title', 'care.where', 'care.pain', 'care.symptoms', 'care.conditions', 'care.send', 'care.urgent', 'care.optional',
  'settings.title', 'settings.language',
  'onboard.chooseLanguage', 'onboard.start',
] as const satisfies readonly StringKey[];

/**
 * Strings a pack may never supply: airline-approved safety wording and the
 * honest notices about simulated speech. Machine or unreviewed translation
 * must not be able to reach them.
 */
export const RESERVED_KEY_PREFIXES = ['safety.', 'speech.simulated'] as const;

export function isReservedKey(key: string): boolean {
  return RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p));
}
