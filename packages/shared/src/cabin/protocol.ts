import type { CrewMessage, LangCode, MedicalReport, NeedPurpose, ProfileTag, ReplyId, RequestSource, Understanding } from '../types';

/**
 * Messages exchanged between passenger devices (phone web app / seatback IFE)
 * and the crew tablet over the cabin network. On the cabin Wi-Fi they travel
 * as WebSocket frames to the cabin hub (`apps/hub`, the crew tablet service,
 * no internet). Without a hub they run over an in-memory or BroadcastChannel
 * `CabinBus` (see `bus.ts` and `ws.ts`).
 *
 * Privacy: messages carry the seat, language, need id and (only with consent)
 * profile tags. No names, no audio, no transcripts. Care Mode adds only the
 * body areas, pain level and symptoms the passenger chose to share.
 */

export type DeviceKind = 'phone' | 'ife';

export type PassengerToCrew =
  | {
      type: 'request.create';
      requestId: string;
      seat: string;
      device: DeviceKind;
      lang: LangCode;
      needId: string;
      purposeId?: NeedPurpose['id'];
      source: RequestSource;
      tags: ProfileTag[];
      createdAt: number;
      understanding?: Understanding;
      medical?: MedicalReport;
      /** Language the passenger spoke or typed, when it differs from the screen language (language packs). */
      spokenLang?: string;
    }
  | { type: 'request.cancel'; requestId: string; seat: string }
  | { type: 'request.thanks'; requestId: string; seat: string };

export type CrewToPassenger =
  | { type: 'request.received'; requestId: string; seat: string }
  | { type: 'request.reply'; requestId: string; seat: string; replyId?: ReplyId; message?: CrewMessage; crewName?: string; at: number }
  | { type: 'announcement'; id: string; templateId: string; at: number }
  | { type: 'crew.heartbeat'; at: number };

export type CabinMessage = PassengerToCrew | CrewToPassenger;

export function isCrewMessage(m: CabinMessage): m is CrewToPassenger {
  return m.type === 'request.received' || m.type === 'request.reply' || m.type === 'announcement' || m.type === 'crew.heartbeat';
}
