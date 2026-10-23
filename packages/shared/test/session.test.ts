import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrewTablet, LocalHub, crewReplyText, PassengerSession, SimulatedCabinLink, type CabinBus, type PassengerProfile } from '../src';

const profile: PassengerProfile = { lang: 'hi', seat: '23C', name: 'Sharda', tags: ['senior', 'hard_of_hearing'], shareTagsWithCrew: true };

function setup(opts: { crew?: boolean; autoReply?: boolean; condition?: 'good' | 'unstable' | 'offline'; random?: () => number } = {}) {
  const hub = new LocalHub();
  const passengerBus = hub.connect();
  const spyBus = hub.connect();
  const seen: unknown[] = [];
  spyBus.subscribe((m) => seen.push(m));
  let crew: CrewTablet | undefined;
  let crewBus: CabinBus | undefined;
  if (opts.crew !== false) {
    crewBus = hub.connect();
    crew = new CrewTablet(crewBus, { autoReply: opts.autoReply ?? false, autoReplyDelayMs: 2000 });
  }
  const link = new SimulatedCabinLink(passengerBus, { condition: opts.condition ?? 'good', random: opts.random });
  let n = 0;
  const session = new PassengerSession({ link, device: 'phone', idFactory: () => `r${++n}` });
  session.setProfile(profile);
  return { session, link, crew, seen };
}

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('PassengerSession delivery states', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pending → sent only after the crew tablet confirms → acknowledged on reply', async () => {
    const { session, crew } = setup();
    await flush(10);
    const res = session.submit({ needId: 'hot_water', purposeId: 'for_medicine', source: 'tap' });
    expect(res.ok).toBe(true);
    expect(session.getState().requests[0]!.status).toBe('pending');
    await flush(1);
    expect(session.getState().requests[0]!.status).toBe('sent');
    const crewReq = crew!.getState().requests[0]!;
    expect(crewReq).toMatchObject({ seat: '23C', needId: 'hot_water', purposeId: 'for_medicine', lang: 'hi', tags: ['senior', 'hard_of_hearing'] });
    crew!.reply(crewReq.requestId, 'bringing_now');
    await flush(1);
    const r = session.getState().requests[0]!;
    expect(r.status).toBe('acknowledged');
    expect(r.reply?.replyId).toBe('bringing_now');
    expect(session.getState().replyToShow).toBe(r.id);
    session.thank(r.id);
    expect(session.getState().requests[0]!.status).toBe('closed');
    await flush(1);
    expect(crew!.getState().requests[0]!.status).toBe('thanked');
  });

  it('never claims delivery without confirmation: no crew tablet → retries then failed', async () => {
    const { session, seen } = setup({ crew: false });
    session.submit({ needId: 'water', source: 'tap' });
    await flush(4000 + 1000 + 4000 + 2000 + 4000 + 10);
    const r = session.getState().requests[0]!;
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('no_confirmation');
    expect(r.attempts).toBe(3);
    expect(seen.filter((m: any) => m.type === 'request.create')).toHaveLength(3);
  });

  it('offline: waits for connection, then sends when it returns', async () => {
    const { session, link } = setup({ condition: 'offline' });
    await flush(10);
    expect(session.getState().link).toBe('offline');
    session.submit({ needId: 'blanket', source: 'tap' });
    expect(session.getState().requests[0]).toMatchObject({ status: 'pending', waitingForConnection: true, attempts: 0 });
    await flush(20_000);
    expect(session.getState().requests[0]!.status).toBe('pending');
    link.setCondition('good');
    await flush(2100); // heartbeat arrives, request is sent and confirmed
    expect(session.getState().requests[0]!.status).toBe('sent');
  });

  it('offline for too long → failed (no_connection); retry works once back online', async () => {
    const { session, link } = setup({ condition: 'offline' });
    session.submit({ needId: 'tea', source: 'tap' });
    await flush(60_001);
    expect(session.getState().requests[0]).toMatchObject({ status: 'failed', failureReason: 'no_connection' });
    link.setCondition('good');
    await flush(2100);
    session.retry(session.getState().requests[0]!.id);
    await flush(1);
    expect(session.getState().requests[0]!.status).toBe('sent');
  });

  it('unstable link: a lost first attempt is retried and then confirmed', async () => {
    const rolls = [0.1, 0.9, 0.9, 0.9, 0.9, 0.9];
    const { session } = setup({ condition: 'unstable', random: () => rolls.shift() ?? 0.9 });
    await flush(10);
    session.submit({ needId: 'pillow', source: 'tap' });
    await flush(100);
    expect(session.getState().requests[0]!.status).toBe('pending');
    await flush(4000 + 1000 + 10);
    expect(session.getState().requests[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('simulated crew auto-replies with the right template', async () => {
    const { session } = setup({ autoReply: true });
    session.submit({ needId: 'sanitary', source: 'tap' });
    await flush(2100);
    expect(session.getState().requests[0]).toMatchObject({ status: 'acknowledged', reply: { replyId: 'coming_to_seat' } });
  });

  it('rejects duplicates of an open request and unknown needs', () => {
    const { session } = setup();
    expect(session.submit({ needId: 'water', source: 'tap' }).ok).toBe(true);
    expect(session.submit({ needId: 'water', source: 'tap' })).toEqual({ ok: false, reason: 'duplicate' });
    expect(session.submit({ needId: 'nope', source: 'tap' })).toEqual({ ok: false, reason: 'unknown_need' });
  });

  it('drops a purpose the need does not support', () => {
    const { session } = setup();
    const r = session.submit({ needId: 'toilet', purposeId: 'for_medicine', source: 'tap' });
    expect(r.ok && r.request.purposeId).toBeUndefined();
  });

  it('does not share tags without consent', async () => {
    const { session, crew } = setup();
    session.updateProfile({ shareTagsWithCrew: false });
    session.submit({ needId: 'water', source: 'tap' });
    await flush(1);
    expect(crew!.getState().requests[0]!.tags).toEqual([]);
  });

  it("delivers the crew member's own words, marked as machine-translated, and reads them like a verified reply", async () => {
    const { session, crew } = setup();
    session.submit({ needId: 'blanket', source: 'tap' });
    await flush(1);
    const id = crew!.getState().requests[0]!.requestId;
    crew!.sendMessage(id, { original: 'すぐに毛布をお持ちします', text: 'मैं तुरंत कंबल लाऊँगी', lang: 'hi' });
    await flush(1);
    const r = session.getState().requests[0]!;
    expect(r.status).toBe('acknowledged');
    expect(r.reply).toMatchObject({ message: { text: 'मैं तुरंत कंबल लाऊँगी', lang: 'hi' } });
    expect(r.reply?.replyId).toBeUndefined();
    expect(crewReplyText(r.reply, 'hi')).toBe('मैं तुरंत कंबल लाऊँगी');
    expect(crew!.getState().requests[0]!.reply?.message?.original).toBe('すぐに毛布をお持ちします');
  });

  it('ignores messages for another seat', async () => {
    const { session, crew } = setup();
    session.submit({ needId: 'water', source: 'tap' });
    await flush(1);
    session.updateProfile({ seat: '24A' });
    crew!.reply(crew!.getState().requests[0]!.requestId, 'bringing_now');
    await flush(1);
    expect(session.getState().requests[0]!.status).toBe('sent');
  });

  it('clear() withdraws open requests and forgets everything (IFE end session)', async () => {
    const { session, crew } = setup();
    session.submit({ needId: 'water', source: 'tap' });
    await flush(1);
    session.clear();
    expect(session.getState()).toMatchObject({ profile: null, requests: [], announcements: [] });
    await flush(1);
    expect(crew!.getState().requests[0]!.status).toBe('cancelled');
  });

  it('receives announcements and marks them unseen', async () => {
    const { session, crew } = setup();
    crew!.announce('seatbelt_on');
    await flush(1);
    expect(session.getState().announcements[0]!.templateId).toBe('seatbelt_on');
    expect(session.getState().unseenAnnouncement).toBe(session.getState().announcements[0]!.id);
  });

  it('link status reflects crew heartbeats', async () => {
    const { session, link, crew } = setup();
    await flush(10);
    expect(link.getStatus()).toBe('online');
    crew!.dispose();
    await flush(8000);
    expect(session.getState().link).toBe('no_crew');
  });
});
