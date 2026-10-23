import {
  CrewTablet,
  LocalHub,
  isCrewMessage,
  parseClientFrame,
  type CabinMessage,
  type ClientFrame,
  type CrewTabletState,
  type HubEvent,
  type HubRole,
  type ServerFrame,
} from '@hearme/shared';
import type { RawData, WebSocket, WebSocketServer } from 'ws';

/**
 * The cabin network inside the hub.
 *
 * Passenger devices (phones, seatback screens) send requests over WebSocket;
 * the hub's crew tablet (the shared `CrewTablet` model) receives them, confirms
 * receipt and holds the request list that every crew console shows. Crew
 * replies go back only to the devices registered for that seat.
 */

interface Client {
  ws: WebSocket;
  role: HubRole | null;
  seat?: string;
  alive: boolean;
}

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CLIENTS = 300;

export interface RelayOptions {
  crewName?: string;
  heartbeatMs?: number;
  pingMs?: number;
}

export class CabinRelay {
  readonly crew: CrewTablet;
  private clients = new Set<Client>();
  private hub = new LocalHub();
  private toCrew = this.hub.connect();
  private crewSide = this.hub.connect();
  private pingTimer: ReturnType<typeof setInterval>;
  private unsubs: (() => void)[] = [];

  constructor(options: RelayOptions = {}) {
    this.crew = new CrewTablet(this.crewSide, { crewName: options.crewName ?? 'Aoi', heartbeatMs: options.heartbeatMs ?? 2000 });
    this.unsubs.push(this.toCrew.subscribe((m) => this.fromCrewTablet(m)));
    this.unsubs.push(this.crew.subscribe((state) => this.pushCrewState(state)));
    this.pingTimer = setInterval(() => this.ping(), options.pingMs ?? 15_000);
  }

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws) => this.onConnection(ws));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Tell crew consoles and the demo stage what the speech AI understood (text only). */
  emitEvent(event: HubEvent): void {
    const frame: ServerFrame = { kind: 'event', event };
    for (const c of this.clients) if (c.role === 'observer' || c.role === 'crew') this.send(c, frame);
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.unsubs.forEach((u) => u());
    this.crew.dispose();
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
  }

  private onConnection(ws: WebSocket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      ws.close(1013, 'hub busy');
      return;
    }
    const client: Client = { ws, role: null, alive: true };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    const text = data.toString();
    if (text.length > MAX_FRAME_BYTES) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const frame = parseClientFrame(raw);
    if (frame) this.handle(client, frame);
  }

  private handle(client: Client, frame: ClientFrame): void {
    switch (frame.kind) {
      case 'hello':
        client.role = frame.role;
        client.seat = frame.seat;
        if (frame.role === 'crew' || frame.role === 'observer') this.send(client, { kind: 'crewState', state: this.crew.getState() });
        return;
      case 'cabin':
        if (client.role !== 'passenger') return;
        // A device may only speak for the seat it registered with.
        if (!client.seat || frame.msg.seat !== client.seat) return;
        this.toCrew.post(frame.msg);
        this.toObservers({ kind: 'cabin', msg: frame.msg });
        return;
      case 'crew': {
        if (client.role !== 'crew') return;
        const cmd = frame.cmd;
        if (cmd.type === 'reply') this.crew.reply(cmd.requestId, cmd.replyId);
        else if (cmd.type === 'message') this.crew.sendMessage(cmd.requestId, cmd.message);
        else if (cmd.type === 'announce') this.crew.announce(cmd.templateId);
        else if (cmd.type === 'autoReply') this.crew.setAutoReply(cmd.on);
        else if (cmd.type === 'reset') this.crew.reset();
        return;
      }
    }
  }

  /** Crew tablet → passenger devices (and the demo stage). */
  private fromCrewTablet(m: CabinMessage): void {
    if (!isCrewMessage(m)) return;
    const frame: ServerFrame = { kind: 'cabin', msg: m };
    const seat = m.type === 'request.received' || m.type === 'request.reply' ? m.seat : null;
    for (const c of this.clients) {
      if (c.role !== 'passenger') continue;
      if (seat === null || c.seat === seat) this.send(c, frame);
    }
    if (m.type !== 'crew.heartbeat') this.toObservers(frame);
  }

  private pushCrewState(state: CrewTabletState): void {
    const frame: ServerFrame = { kind: 'crewState', state };
    for (const c of this.clients) if (c.role === 'crew' || c.role === 'observer') this.send(c, frame);
  }

  private toObservers(frame: ServerFrame): void {
    for (const c of this.clients) if (c.role === 'observer') this.send(c, frame);
  }

  private send(client: Client, frame: ServerFrame): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    try {
      client.ws.send(JSON.stringify(frame));
    } catch {
      /* the close handler cleans up */
    }
  }

  private ping(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }
}
