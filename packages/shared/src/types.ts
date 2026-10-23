/**
 * Core domain types shared by the mobile app, the IFE seatback app and the
 * crew console simulator.
 */

/**
 * The six core languages: every catalogue label, interface string and verified
 * reply exists in all of them, reviewed as a set (the PDF targets 6 for the
 * hackathon prototype).
 */
export type CoreLang = 'hi' | 'en' | 'ja' | 'th' | 'id' | 'vi';

/**
 * Every language a passenger can choose. Beyond the six core ones come the
 * *pack languages*, added as data (`packages/shared/src/i18n/packs/`): they
 * carry their own request vocabulary, screen text and replies, and fall back
 * to a core language for anything a pack does not translate yet. How complete
 * each one is, layer by layer, is declared in `i18n/languages.ts` — ask
 * `coverageOf(lang)` rather than assuming.
 */
export type LangCode = CoreLang | 'bn' | 'ta' | 'pa' | 'mr';

/**
 * Text available in every core language, and in whichever pack languages have
 * been translated. Read it with `needLabel` / `replyTextOf` / `t` rather than
 * indexing, so untranslated keys fall back instead of coming out `undefined`.
 */
export type Localized = Record<CoreLang, string> & Partial<Record<LangCode, string>>;

export type NeedCategory = 'drinks' | 'comfort' | 'food' | 'help' | 'private';

/** Names of pictograms. Each app maps these to its own icon renderer (lucide-react / lucide-react-native). */
export type IconName =
  | 'glass-water'
  | 'coffee'
  | 'cup-soda'
  | 'bed'
  | 'snowflake'
  | 'sun'
  | 'utensils'
  | 'leaf'
  | 'cookie'
  | 'toilet'
  | 'pill'
  | 'thermometer'
  | 'hand-helping'
  | 'luggage'
  | 'accessibility'
  | 'bell-ring'
  | 'lock'
  | 'headphones'
  | 'heart-pulse'
  | 'baby'
  | 'shield'
  | 'help-circle'
  | 'shopping-bag'
  | 'armchair'
  | 'milk'
  | 'eye-off'
  | 'monitor-play'
  | 'battery-charging'
  | 'file-text'
  | 'plane-takeoff'
  | 'clock'
  | 'search'
  | 'shield-alert'
  | 'heart'
  | 'salad'
  | 'user-x'
  | 'droplets'
  | 'stethoscope';

export interface NeedPurpose {
  id: 'for_medicine' | 'vegetarian' | 'for_child' | 'urgent';
  label: Localized;
}

export interface Need {
  id: string;
  category: NeedCategory;
  icon: IconName;
  label: Localized;
  /** Optional purposes the passenger can attach (e.g. hot water "for medicine"). */
  purposes?: NeedPurpose['id'][];
  /** Shown on the home grid (the most common needs). */
  common?: boolean;
  /** Private needs show a neutral confirmation on screen and are flagged to crew as discreet. */
  private?: boolean;
  /** Speech/typed matching vocabulary. `phrases` are strong matches, `hints` are weak ones. */
  phrases: Partial<Record<LangCode, string[]>>;
  hints?: Partial<Record<LangCode, string[]>>;
}

export type RequestSource = 'tap' | 'speech' | 'typed';

/**
 * How a spoken or typed request was understood (sent to crew for the live
 * "understood first time" numbers). Taps have no understanding step.
 */
export interface Understanding {
  /** Matcher confidence 0..1 for the need that was finally sent. */
  confidence: number;
  /** True when the passenger had to pick from the "Did you mean?" pictures. */
  viaPictures: boolean;
}

/** Care Mode: where it hurts, how much, what else. Shown to crew in Japanese + English. */
export type BodyArea = 'head' | 'eyes_ears' | 'throat' | 'chest' | 'stomach' | 'back' | 'arms' | 'legs';
export type SymptomId = 'dizzy' | 'nausea' | 'breathing' | 'fever' | 'allergy' | 'bleeding' | 'faint' | 'numb';
export type ConditionId = 'diabetes' | 'heart' | 'asthma' | 'blood_pressure' | 'pregnant' | 'epilepsy';

export interface MedicalReport {
  areas: BodyArea[];
  /** 0 (no pain) … 10 (worst pain); null when the passenger did not pick a number. */
  pain: number | null;
  symptoms: SymptomId[];
  conditions: ConditionId[];
}

/**
 * Request lifecycle. Delivery is only claimed when the crew tablet confirms it:
 *  pending      – created locally, not yet confirmed by the crew tablet (queued / sending / retrying)
 *  sent         – the crew tablet confirmed it received the request
 *  acknowledged – a crew member replied
 *  failed       – could not be delivered; passenger can retry or show the card instead
 *  cancelled    – passenger withdrew it
 *  closed       – passenger said thank you / it is done
 */
export type RequestStatus = 'pending' | 'sent' | 'acknowledged' | 'failed' | 'cancelled' | 'closed';

export type ReplyId =
  | 'bringing_now'
  | 'one_moment'
  | 'coming_to_seat'
  | 'after_seatbelt'
  | 'not_available'
  | 'ground_informed'
  | 'here_you_go'
  | 'doctor_coming'
  | 'stay_seated'
  | 'meal_soon'
  | 'staff_on_arrival';

/**
 * A crew member's own words, machine-translated offline. Not checked like
 * the verified replies, so the passenger is told it may be wrong.
 */
export interface CrewMessage {
  /** What the crew member said or typed (Japanese). */
  original: string;
  /** The machine translation the passenger reads. */
  text: string;
  /** The language `text` is in. */
  lang: string;
}

/** A verified reply (`replyId`), or the crew member's own words (`message`). */
export interface CrewReply {
  replyId?: ReplyId;
  message?: CrewMessage;
  /** Crew first name only, no surname. */
  crewName?: string;
  at: number;
}

export interface PassengerRequest {
  id: string;
  needId: string;
  purposeId?: NeedPurpose['id'];
  source: RequestSource;
  /** Transcript is kept only in memory for this request; audio is never stored. */
  createdAt: number;
  updatedAt: number;
  status: RequestStatus;
  /** Delivery attempts made for the current pending period. */
  attempts: number;
  /** True while waiting for a connection rather than actively sending. */
  waitingForConnection: boolean;
  failureReason?: 'no_connection' | 'no_confirmation';
  sentAt?: number;
  reply?: CrewReply;
  understanding?: Understanding;
  /** Care Mode details (only for the "I feel unwell" need). */
  medical?: MedicalReport;
}

/** Profile tags the passenger may choose to share with crew. */
export type ProfileTag = 'senior' | 'hard_of_hearing' | 'low_vision' | 'wheelchair' | 'medical' | 'travelling_with_child';

export interface PassengerProfile {
  lang: LangCode;
  seat: string;
  /** Optional, mobile only. Never shown on the shared IFE screen. */
  name?: string;
  tags: ProfileTag[];
  /** Passenger consent to send profile tags with requests. */
  shareTagsWithCrew: boolean;
  /**
   * A language the passenger speaks that HearMe understands through a
   * language pack but has no screens for yet (e.g. "bn"): speech and typing
   * are understood in it, screens and replies use `lang`.
   */
  speechLang?: string;
}

export type ReplyChannel = 'text' | 'voice' | 'buzz';

export interface AccessibilityPrefs {
  textScale: 1 | 1.25 | 1.5;
  highContrast: boolean;
  /** How crew replies are delivered. Text is always shown. */
  replyChannels: ReplyChannel[];
  reduceMotion: boolean;
  /**
   * Result of the passenger's voice check ("Can you hear the crew's replies?"):
   * heard it, did not hear it, or the device has no voice for their language.
   */
  voiceCheck?: 'ok' | 'not_heard' | 'no_voice';
}

export interface Announcement {
  id: string;
  templateId: string;
  at: number;
}

/**
 * Connection to the crew tablet as the passenger device sees it.
 *  online   – on the cabin network and the crew tablet is answering
 *  no_crew  – on the cabin network, but the crew tablet has not been heard from recently
 *  offline  – not connected to the cabin network
 */
export type LinkStatus = 'online' | 'no_crew' | 'offline';
