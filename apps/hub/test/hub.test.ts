import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DemoCabinLink,
  PassengerSession,
  RemoteCrewTablet,
  floatToPcm16,
  type Embedder,
  type WebSocketLike,
} from '@hearme/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { AiEngine, hasSpeech, trimSilence } from '../src/ai';
import { CabinRelay } from '../src/relay';
import { createHandler } from '../src/server';

const factory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;

/** A tiny deterministic "embedding": bag of characters, normalised. Enough to test the plumbing. */
const fakeEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % 64]! += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

const waitFor = async (check: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let server: Server;
let relay: CabinRelay;
let base: string;
let ai: AiEngine;
let staticDir: string;

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'hearme-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
  ai = new AiEngine({
    asrSize: 'base',
    threads: 1,
    loadEmbedder: async () => fakeEmbedder,
    loadAsr: async () => ({ transcribe: async (_s, lang) => (lang === 'hi' ? 'मुझे गरम पानी चाहिए' : 'hot water please') }),
    loadTranslator: async () => ({ translate: async (text, from, to) => `[${from}→${to}] ${text}` }),
  });
  await ai.start();
  relay = new CabinRelay({ heartbeatMs: 200, pingMs: 60_000 });
  const handler = createHandler({ staticDir, ai, relay, urls: () => ({ base: 'http://localhost', lan: [] }), version: 'test' });
  const wss = new WebSocketServer({ noServer: true });
  relay.attach(wss);
  server = createServer((req, res) => void handler(req, res));
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  relay.close();
  await new Promise((r) => server.close(r));
});

describe('cabin hub', () => {
  it('reports its status and models', async () => {
    const s = await (await fetch(`${base}/api/status`)).json();
    expect(s.name).toBe('hearme-hub');
    expect(s.asr.state).toBe('ready');
    expect(s.embed.state).toBe('ready');
  });

  it('delivers a phone request to the shared crew tablet and the reply back to that seat only', async () => {
    const crew = new RemoteCrewTablet(base, { factory });
    const link = new DemoCabinLink('hub', { hubUrl: base, wsFactory: factory });
    const other = new DemoCabinLink('hub', { hubUrl: base, wsFactory: factory });
    const session = new PassengerSession({ link, device: 'phone' });
    const neighbour = new PassengerSession({ link: other, device: 'phone' });
    try {
      session.setProfile({ lang: 'hi', seat: '23C', tags: ['senior'], shareTagsWithCrew: true });
      neighbour.setProfile({ lang: 'th', seat: '21A', tags: [], shareTagsWithCrew: false });
      await waitFor(() => session.getState().link === 'online');
      const res = session.submit({ needId: 'hot_water', purposeId: 'for_medicine', source: 'speech', understanding: { confidence: 0.62, viaPictures: true } });
      expect(res.ok).toBe(true);
      await waitFor(() => crew.getState().requests.length === 1);
      const req = crew.getState().requests[0]!;
      expect(req).toMatchObject({ seat: '23C', needId: 'hot_water', purposeId: 'for_medicine', lang: 'hi', understanding: { viaPictures: true } });
      await waitFor(() => session.getState().requests[0]!.status === 'sent');

      crew.reply(req.requestId, 'bringing_now');
      await waitFor(() => session.getState().requests[0]!.status === 'acknowledged');
      expect(session.getState().replyToShow).toBe(res.ok && res.request.id);
      expect(neighbour.getState().requests).toHaveLength(0);
      expect(neighbour.getState().replyToShow).toBeNull();
    } finally {
      session.dispose();
      neighbour.dispose();
      link.dispose();
      other.dispose();
      crew.dispose();
    }
  });

  it('broadcasts announcements to every passenger device', async () => {
    const crew = new RemoteCrewTablet(base, { factory });
    const link = new DemoCabinLink('hub', { hubUrl: base, wsFactory: factory });
    const session = new PassengerSession({ link, device: 'ife' });
    try {
      session.setProfile({ lang: 'vi', seat: '31A', tags: [], shareTagsWithCrew: false });
      await waitFor(() => session.getState().link === 'online' && crew.isConnected());
      crew.announce('seatbelt_on');
      await waitFor(() => session.getState().announcements.length === 1);
      expect(session.getState().announcements[0]!.templateId).toBe('seatbelt_on');
    } finally {
      session.dispose();
      link.dispose();
      crew.dispose();
    }
  });

  it("translates a crew member's own words and delivers them to that seat only", async () => {
    const t = await (await fetch(`${base}/api/translate`, { method: 'POST', body: JSON.stringify({ text: 'すぐにお持ちします', to: 'hi' }) })).json();
    expect(t).toMatchObject({ text: '[ja→hi] すぐにお持ちします', machine: true });
    expect((await fetch(`${base}/api/translate`, { method: 'POST', body: JSON.stringify({ text: '', to: 'hi' }) })).status).toBe(400);
    expect((await fetch(`${base}/api/translate`, { method: 'POST', body: JSON.stringify({ text: 'x', to: 'zz' }) })).status).toBe(400);
    const crew = new RemoteCrewTablet(base, { factory });
    const link = new DemoCabinLink('hub', { hubUrl: base, wsFactory: factory });
    const session = new PassengerSession({ link, device: 'phone' });
    try {
      session.setProfile({ lang: 'hi', seat: '23C', tags: [], shareTagsWithCrew: false });
      await waitFor(() => session.getState().link === 'online' && crew.isConnected());
      session.submit({ needId: 'blanket', source: 'tap' });
      await waitFor(() => crew.getState().requests.length === 1);
      crew.sendMessage(crew.getState().requests[0]!.requestId, { original: 'すぐにお持ちします', text: t.text, lang: 'hi' });
      await waitFor(() => !!session.getState().requests[0]?.reply);
      expect(session.getState().requests[0]!.reply?.message).toMatchObject({ original: 'すぐにお持ちします', text: t.text });
      expect(crew.getState().requests[0]!.status).toBe('replied');
    } finally {
      session.dispose();
      link.dispose();
      crew.dispose();
    }
  });

  it('drops malformed frames and requests for a seat the device did not register', async () => {
    const crew = new RemoteCrewTablet(base, { factory });
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    await new Promise((r) => ws.once('open', r));
    ws.send('not json');
    ws.send(JSON.stringify({ kind: 'hello', role: 'passenger', seat: '23C' }));
    ws.send(JSON.stringify({ kind: 'cabin', msg: { type: 'request.create', requestId: 'x1', seat: '23C', device: 'phone', lang: 'xx', needId: 'water', source: 'tap', tags: [], createdAt: 1 } }));
    ws.send(JSON.stringify({ kind: 'cabin', msg: { type: 'request.create', requestId: 'x2', seat: '24A', device: 'phone', lang: 'en', needId: 'water', source: 'tap', tags: [], createdAt: 1 } }));
    ws.send(JSON.stringify({ kind: 'crew', cmd: { type: 'reset' } }));
    ws.send(JSON.stringify({ kind: 'cabin', msg: { type: 'request.create', requestId: 'ok1', seat: '23C', device: 'phone', lang: 'en', needId: 'water', source: 'tap', tags: [], createdAt: 1 } }));
    try {
      await waitFor(() => crew.getState().requests.length === 1);
      await new Promise((r) => setTimeout(r, 150));
      expect(crew.getState().requests.map((r) => r.requestId)).toEqual(['ok1']);
    } finally {
      ws.close();
      crew.dispose();
    }
  });

  it('understands speech (PCM) and emits a matched need', async () => {
    const tone = new Float32Array(16000).map((_, i) => 0.3 * Math.sin(i / 5));
    const res = await fetch(`${base}/api/understand?lang=hi`, { method: 'POST', headers: { 'Content-Type': 'audio/L16;rate=16000;channels=1' }, body: Buffer.from(floatToPcm16(tone)) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.transcript).toBe('मुझे गरम पानी चाहिए');
    expect(body.match.candidates[0].needId).toBe('hot_water');
  });

  it('matches typed text and looks up bookings', async () => {
    const m = await (await fetch(`${base}/api/match`, { method: 'POST', body: JSON.stringify({ text: 'blanket please', lang: 'en' }) })).json();
    expect(m.match.candidates[0].needId).toBe('blanket');
    const b = await (await fetch(`${base}/api/booking?seat=23C`)).json();
    expect(b.profile).toMatchObject({ lang: 'hi', seat: '23C' });
    expect((await fetch(`${base}/api/booking?seat=99Z`)).status).toBe(404);
    expect((await fetch(`${base}/api/understand?lang=zz`, { method: 'POST', body: 'x' })).status).toBe(400);
  });

  it('understands several requests and refusals in one sentence, and tells the stage once', async () => {
    const emit = vi.spyOn(relay, 'emitEvent');
    const text = '“मुझे ठंडा पानी नहीं चाहिए, दवाई लेने के लिए थोड़ा गरम पानी और एक कंबल चाहिए, लेकिन खाना मत भेजिए।”';
    const m = await (await fetch(`${base}/api/match`, { method: 'POST', body: JSON.stringify({ text, lang: 'hi' }) })).json();
    expect(m.many.requests.map((r: { needId: string }) => r.needId).sort()).toEqual(['blanket', 'hot_water']);
    expect(m.many.refused.sort()).toEqual(['meal', 'water']);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: 'understood',
      requests: expect.arrayContaining([{ needId: 'hot_water', purposeId: 'for_medicine' }, { needId: 'blanket' }]),
      refused: expect.arrayContaining(['meal', 'water']),
    });
    // One request carries no list.
    const one = await (await fetch(`${base}/api/match`, { method: 'POST', body: JSON.stringify({ text: 'blanket please', lang: 'en' }) })).json();
    expect(one.many).toBeUndefined();
  });

  it('lists language packs and understands their language (Bengali: typed, with a Bengali booking)', async () => {
    const l = await (await fetch(`${base}/api/languages`)).json();
    expect(l.builtIn).toHaveLength(6);
    // Ten languages, each with its coverage spelled out layer by layer.
    expect(l.languages).toHaveLength(10);
    const bengali = l.languages.find((x: { code: string }) => x.code === 'bn');
    expect(bengali).toMatchObject({ core: false, fallback: 'en', coverage: { intent: 'complete', ui: 'partial', replies: 'complete' } });
    expect(bengali.uiStrings).toBeGreaterThan(80);
    expect(l.languages.filter((x: { core: boolean }) => x.core)).toHaveLength(6);
    expect(l.packs.map((p: { code: string }) => p.code)).toContain('bn');
    const m = await (await fetch(`${base}/api/match`, { method: 'POST', body: JSON.stringify({ text: 'একটা কম্বল দিন', lang: 'bn' }) })).json();
    expect(m.match.candidates[0].needId).toBe('blanket');
    // 22B's booking says Bengali, and Bengali now has screens of its own, so the
    // passenger reads Bengali rather than speaking Bengali at English screens.
    const b = await (await fetch(`${base}/api/booking?seat=22B`)).json();
    expect(b.profile).toMatchObject({ lang: 'bn' });
    expect(b.profile.speechLang).toBeUndefined();
    const r = await (await fetch(`${base}/api/languages/reload`, { method: 'POST' })).json();
    // Bengali ships with the apps now, so it is in `languages`, not in the
    // re-read `drafts` (which hold only data/languages/*.json experiments).
    expect(r.languages).toContain('bn');
    expect(r.drafts).not.toContain('bn');
  });

  it('serves static files without leaving the static folder', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'assets', 'app-1a2b3c4d.js'), 'export {};');
    const asset = await fetch(`${base}/assets/app-1a2b3c4d.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    // A secret next to the static folder, reached with '/' or Windows '\' separators.
    writeFileSync(join(staticDir, '..', 'hearme-secret.txt'), 'secret');
    for (const p of ['/..%2fhearme-secret.txt', '/..%5chearme-secret.txt', '/assets/..%5c..%5chearme-secret.txt', '/..%2f..%2fetc%2fpasswd']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).not.toBe(200);
      expect(await r.text(), p).not.toContain('secret');
    }
    rmSync(join(staticDir, '..', 'hearme-secret.txt'));
  });
});

describe('speech gate', () => {
  it('ignores silence (Whisper would invent words)', () => {
    expect(hasSpeech(new Float32Array(16000))).toBe(false);
    expect(hasSpeech(new Float32Array(16000).map((_, i) => 0.2 * Math.sin(i / 4)))).toBe(true);
  });
});

describe('AI engine resilience', () => {
  const tone = (seconds: number) => Float32Array.from({ length: 16000 * seconds }, (_, i) => 0.2 * Math.sin(i / 5));

  it('trims the silence around speech', () => {
    const clip = new Float32Array(16000 * 3);
    clip.set(tone(1), 16000);
    const trimmed = trimSilence(clip)!;
    expect(trimmed.length).toBeGreaterThan(16000 * 0.9);
    expect(trimmed.length).toBeLessThan(16000 * 1.6);
  });

  it('reloads the speech model after two failures and falls back to keywords when meaning-matching fails', async () => {
    let loads = 0;
    let embedderBroken = false;
    const engine = new AiEngine({
      asrSize: 'small',
      threads: 1,
      loadAsr: async () => {
        loads++;
        return { transcribe: async () => Promise.reject(new Error('onnx failed')) };
      },
      loadEmbedder: async () => ({
        embed: async (texts: string[]) => {
          if (embedderBroken) throw new Error('embedder down');
          return texts.map(() => new Float32Array(384).fill(0.05));
        },
      }),
    });
    await engine.start();
    await expect(engine.transcribe(tone(1), 'hi')).rejects.toThrow('onnx failed');
    await expect(engine.transcribe(tone(1), 'hi')).rejects.toThrow('onnx failed');
    await new Promise((r) => setTimeout(r, 20));
    expect(loads).toBe(2);

    embedderBroken = true;
    const m = await engine.matchNeeds('hot water for my medicine');
    expect(m.candidates[0]?.needId).toBe('hot_water');
  });
});
