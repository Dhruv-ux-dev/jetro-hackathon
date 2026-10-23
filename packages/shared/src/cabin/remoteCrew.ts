import type { CrewMessage, ReplyId } from '../types';
import type { CrewTabletApi, CrewTabletState } from './crewTablet';
import { hubSocketUrl, type HubEvent } from './hubProtocol';
import { WebSocketBus, type WebSocketFactory } from './ws';

/**
 * A crew console's view of the crew tablet that runs inside the cabin hub.
 * Every crew device sees the same list; taps are sent to the hub as commands
 * and the hub pushes the new state back.
 */
export class RemoteCrewTablet implements CrewTabletApi {
  readonly remote = true;
  private state: CrewTabletState = { requests: [], announcements: [], autoReply: false };
  private listeners = new Set<(s: CrewTabletState) => void>();
  private eventListeners = new Set<(e: HubEvent) => void>();
  private connListeners = new Set<(up: boolean) => void>();
  private bus: WebSocketBus;

  constructor(hubUrl: string, options: { factory?: WebSocketFactory; role?: 'crew' | 'observer' } = {}) {
    this.bus = new WebSocketBus(hubSocketUrl(hubUrl), { role: options.role ?? 'crew', factory: options.factory });
    this.bus.onFrame((f) => {
      if (f.kind === 'crewState') {
        this.state = f.state;
        this.listeners.forEach((l) => l(this.state));
      } else if (f.kind === 'event') {
        this.eventListeners.forEach((l) => l(f.event));
      }
    });
    this.bus.onChange((up) => this.connListeners.forEach((l) => l(up)));
  }

  getState(): CrewTabletState {
    return this.state;
  }

  subscribe(listener: (s: CrewTabletState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Speech understood by the hub (for consoles that show what was heard). */
  onEvent(listener: (e: HubEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.bus.isUp();
  }

  onConnection(listener: (up: boolean) => void): () => void {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  reply(requestId: string, replyId: ReplyId): void {
    this.bus.sendFrame({ kind: 'crew', cmd: { type: 'reply', requestId, replyId } });
  }

  sendMessage(requestId: string, message: CrewMessage): void {
    this.bus.sendFrame({ kind: 'crew', cmd: { type: 'message', requestId, message } });
  }

  announce(templateId: string): void {
    this.bus.sendFrame({ kind: 'crew', cmd: { type: 'announce', templateId } });
  }

  setAutoReply(on: boolean): void {
    this.bus.sendFrame({ kind: 'crew', cmd: { type: 'autoReply', on } });
  }

  reset(): void {
    this.bus.sendFrame({ kind: 'crew', cmd: { type: 'reset' } });
  }

  dispose(): void {
    this.bus.close();
    this.listeners.clear();
    this.eventListeners.clear();
    this.connListeners.clear();
  }
}
