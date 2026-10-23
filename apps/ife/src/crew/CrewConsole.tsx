import { JalBrand } from '../common/JalBrand';
import {
  t,
  ago,
  ANNOUNCEMENTS,
  announceCrewConsole,
  computeCrewMetrics,
  createBroadcastBus,
  type CrewRequest,
  CrewTablet,
  type CrewTabletApi,
  defaultReplyFor,
  formatDuration,
  getNeed,
  getPurpose,
  getReply,
  type HubEvent,
  isUrgentMedical,
  type LangCode,
  languageInfo,
  languageName,
  lookupBookingOnHub,
  medicalSummaryLines,
  type PassengerProfile,
  type ProfileTag,
  RemoteCrewTablet,
  REPLIES,
  REPLY_SUGGEST_MIN,
  type ReplyId,
  replyTextOf,
  type UnderstandProgress,
} from '@hearme/shared';
import { useExternal } from '@hearme/shared/react';
import { MicRecorder, MicUnavailableError, recordAndUnderstand } from '@hearme/shared/web';
import { Activity, FileText, Flame, Info, Keyboard, Lock, Megaphone, Mic, MousePointerClick, Printer, RotateCcw, Square, Stethoscope, Users, Wifi, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { NeedIcon } from '../common/Icon';
import { detectHub, hubBaseUrl } from '../common/hub';
import { playChime } from '../common/sounds';
import { openFlightReport, openMedicalHandover } from './reports';

/**
 * Crew console — "Crew app: requests by seat, with one-tap replies" from the
 * idea deck. With a cabin hub it shows the hub's shared request list (any
 * number of crew devices); without one it falls back to a crew tablet in this
 * browser that passenger tabs reach over BroadcastChannel.
 */
type Conn = { kind: 'hub' | 'local'; tablet: CrewTabletApi } | { kind: 'unsupported' };

export function CrewConsole() {
  const [conn, setConn] = useState<Conn | null>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined as void;
    detectHub().then((hub) => {
      if (disposed) return;
      if (hub) {
        const tablet = new RemoteCrewTablet(hubBaseUrl());
        cleanup = () => tablet.dispose();
        setConn({ kind: 'hub', tablet });
        return;
      }
      const bus = createBroadcastBus();
      if (!bus) return setConn({ kind: 'unsupported' });
      const tablet = new CrewTablet(bus, { crewName: 'Aoi', autoReplyDelayMs: 2500 });
      // Passenger tabs in this browser switch from their simulated crew to this console.
      const stopAnnouncing = announceCrewConsole();
      cleanup = () => {
        stopAnnouncing();
        tablet.dispose();
        bus.close();
      };
      setConn({ kind: 'local', tablet });
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
  if (conn === null) return <div className="crew2 crew2--loading">Connecting to the crew tablet…</div>;
  if (conn.kind === 'unsupported') {
    return (
      <div className="crew2">
        <p role="alert">No cabin hub found and this browser cannot simulate one. Start the hub with “npm run demo”.</p>
      </div>
    );
  }
  return <Console tablet={conn.tablet} viaHub={conn.kind === 'hub'} />;
}

const LANG_JA: Record<LangCode, string> = {
  hi: 'ヒンディー語', en: '英語', ja: '日本語', th: 'タイ語', id: 'インドネシア語', vi: 'ベトナム語',
  bn: 'ベンガル語', ta: 'タミル語', pa: 'パンジャブ語', mr: 'マラーティー語',
};
const tagJa = (tag: ProfileTag) => t('ja', `tag.${tag}`);
const tagEn = (tag: ProfileTag) => t('en', `tag.${tag}`);
const embedded = new URLSearchParams(window.location.search).has('embed');

function priority(r: CrewRequest): number {
  if (r.status === 'new' && isUrgentMedical(r.medical)) return 0;
  if (r.status === 'new') return 1;
  if (r.status === 'replied') return 2;
  return 3;
}

function useTick(ms = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
}

function Console({ tablet, viaHub }: { tablet: CrewTabletApi; viaHub: boolean }) {
  const state = useExternal(tablet);
  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [heard, setHeard] = useState<Extract<HubEvent, { type: 'understood' }> | null>(null);
  const [connected, setConnected] = useState(true);
  const [heat, setHeat] = useState(false);
  const [seatInfo, setSeatInfo] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // New requests that arrived while the crew member was looking at another one.
  const [waiting, setWaiting] = useState<string[]>([]);
  const lastShown = useRef<string | null>(null);
  useTick();

  const choose = (id: string) => {
    setSelected(id);
    setWaiting((w) => w.filter((x) => x !== id));
  };

  // Chime when a new request arrives (an urgent tone for serious medical requests). Never switch away from the
  // request on screen: a reply tapped a moment later must go to the seat the crew member was reading.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(state.requests.map((r) => r.requestId));
    if (seen.current) {
      const fresh = state.requests.filter((r) => !seen.current!.has(r.requestId));
      if (fresh.length) {
        playChime(fresh.some((r) => isUrgentMedical(r.medical)) ? 'urgent' : 'new');
        const shown = lastShown.current;
        if (shown && ids.has(shown)) {
          setSelected(shown);
          setWaiting((w) => [...w, ...fresh.map((r) => r.requestId).filter((id) => !w.includes(id))]);
        } else setSelected([...fresh].sort((a, b) => priority(a) - priority(b))[0]!.requestId);
      }
    }
    seen.current = ids;
  }, [state.requests]);

  useEffect(() => {
    if (!(tablet instanceof RemoteCrewTablet)) return;
    setConnected(tablet.isConnected());
    const a = tablet.onConnection(setConnected);
    const b = tablet.onEvent((e) => e.type === 'understood' && e.target === 'needs' && setHeard(e));
    return () => {
      a();
      b();
    };
  }, [tablet]);

  const sorted = useMemo(() => [...state.requests].sort((a, b) => priority(a) - priority(b) || b.receivedAt - a.receivedAt), [state.requests]);
  const sel = state.requests.find((r) => r.requestId === selected) ?? sorted.find((r) => r.status === 'new') ?? sorted[0];
  useEffect(() => {
    lastShown.current = sel?.requestId ?? null;
  });
  const pending = sorted.filter((r) => r.status === 'new' && waiting.includes(r.requestId) && r.requestId !== sel?.requestId);
  const metrics = computeCrewMetrics(state.requests);
  const openSeats = new Map(state.requests.filter((r) => r.status === 'new').map((r) => [r.seat, isUrgentMedical(r.medical) ? 'urgent' : 'open']));
  const doneSeats = new Set(state.requests.filter((r) => r.status === 'replied' || r.status === 'thanked').map((r) => r.seat));
  const perSeat = new Map<string, number>();
  for (const r of state.requests) perSeat.set(r.seat, (perSeat.get(r.seat) ?? 0) + 1);
  const busiest = Math.max(1, ...perSeat.values());

  return (
    <div className={`crew2${embedded ? ' crew2--embedded' : ''}`} lang="ja">
      <header className="crew2-top">
        <div className="crew2-brand">
          <JalBrand label="Cabin crew" />
        </div>
        <span className={`crew2-conn${connected ? '' : ' off'}`} lang="en">
          {connected ? <Wifi aria-hidden /> : <WifiOff aria-hidden />}
          {viaHub ? (connected ? 'Cabin hub' : 'Reconnecting…') : 'This browser only'}
        </span>
        <div className="crew2-metrics" lang="en" aria-label="Live numbers">
          <Metric label="Open" value={String(metrics.open)} alert={metrics.open > 0} />
          <Metric label="Median answer" value={formatDuration(metrics.medianAnswerMs)} />
          <Metric label="Understood 1st time" value={metrics.firstTimeRate === null ? '—' : `${Math.round(metrics.firstTimeRate * 100)}%`} />
          <Metric label="Needed pictures" value={metrics.pictureRate === null ? '—' : `${Math.round(metrics.pictureRate * 100)}%`} />
          <Metric label="Oldest wait" value={metrics.oldestOpenMs === null ? '—' : formatDuration(metrics.oldestOpenMs)} alert={(metrics.oldestOpenMs ?? 0) > 120_000} />
          <Metric label="Medical" value={String(metrics.medical)} alert={metrics.medical > 0} />
          <Metric label="Languages" value={Object.keys(metrics.byLang).length ? Object.keys(metrics.byLang).join(' ') : '—'} />
        </div>
        <label className="crew2-auto" lang="en">
          <input type="checkbox" checked={state.autoReply} onChange={(e) => tablet.setAutoReply(e.target.checked)} /> Auto-reply
        </label>
        <button className="crew2-icon" onClick={() => openFlightReport(state)} title="Post-flight report (print or save as PDF)" aria-label="Flight report">
          <FileText aria-hidden />
        </button>
        <button className="crew2-icon" onClick={() => setConfirmReset(true)} title="Clear all requests (demo reset)" aria-label="Reset demo" aria-expanded={confirmReset}>
          <RotateCcw aria-hidden />
        </button>
        <button className="crew2-icon" onClick={() => setInfo(!info)} aria-expanded={info} aria-label="About this console">
          <Info aria-hidden />
        </button>
      </header>
      {confirmReset && (
        <ConfirmReset
          count={state.requests.length}
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            tablet.reset();
            setSelected(null);
            setWaiting([]);
            setConfirmReset(false);
          }}
        />
      )}
      {info && (
        <div className="crew2-info" lang="en" role="dialog" aria-label="About this console">
          <button className="crew2-icon" onClick={() => setInfo(false)} aria-label="Close">
            <X aria-hidden />
          </button>
          <p>
            <b>Prototype.</b> {viaHub ? 'Connected to the HearMe cabin hub over the local network: every crew device shares this list.' : 'No cabin hub found: this tab is the crew tablet and only passenger tabs in this browser can reach it.'} Not
            integrated with any aircraft or airline system.
          </p>
          <p>Replies and captions are pre-translated templates (prototype drafts, need native review). Crew speech is matched to the closest verified reply; it is never machine-translated.</p>
        </div>
      )}

      <div className="crew2-body">
        <section className="crew2-map" aria-label="Seat map rows 21–26" lang="en">
          <h2>
            Cabin · rows 21–26
            <button className={`crew2-heat${heat ? ' on' : ''}`} onClick={() => setHeat(!heat)} aria-pressed={heat} title="Colour seats by how often they asked this flight">
              <Flame aria-hidden /> Heat
            </button>
          </h2>
          <div className="crew2-cols">
            <span />
            {['A', 'B', 'C', '', 'D', 'E', 'F'].map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </div>
          {[21, 22, 23, 24, 25, 26].map((row) => (
            <div key={row} className="crew2-row">
              <span className="crew2-rownum">{row}</span>
              {['A', 'B', 'C', '', 'D', 'E', 'F'].map((col, i) => {
                if (!col) return <span key={`a${i}`} className="crew2-aisle" />;
                const seat = `${row}${col}`;
                const st = openSeats.get(seat);
                const req = state.requests.find((r) => r.seat === seat && r.status === 'new') ?? state.requests.find((r) => r.seat === seat);
                return (
                  <button
                    key={col}
                    className={`crew2-seat${heat ? ' heat' : st ? ` ${st}` : doneSeats.has(seat) ? ' done' : ''}${seatInfo === seat ? ' picked' : ''}`}
                    style={heat ? ({ '--heat': (perSeat.get(seat) ?? 0) / busiest } as CSSProperties) : undefined}
                    title={seat}
                    aria-label={`${seat}${st ? ', request waiting' : ''}${perSeat.get(seat) ? `, ${perSeat.get(seat)} requests this flight` : ''}`}
                    onClick={() => {
                      setSeatInfo(seat);
                      if (req) choose(req.requestId);
                    }}
                  >
                    {heat ? (perSeat.get(seat) ?? '') : st ? seat : ''}
                  </button>
                );
              })}
            </div>
          ))}
          <ul className="crew2-legend">
            <li>
              <i className="open" /> waiting
            </li>
            <li>
              <i className="urgent" /> medical
            </li>
            <li>
              <i className="done" /> answered
            </li>
          </ul>
          {seatInfo && <SeatCard seat={seatInfo} requests={state.requests} viaHub={viaHub} onClose={() => setSeatInfo(null)} />}
          {heard && <Heard e={heard} />}
        </section>

        <section className="crew2-list" aria-label="Requests">
          {sorted.length === 0 && (
            <div className="crew2-empty">
              <Users aria-hidden />
              <p>
                リクエストはまだありません
                <br />
                <span lang="en">Waiting for passengers. Requests appear here the moment they are sent.</span>
              </p>
            </div>
          )}
          {sorted.map((r) => (
            <RequestCard key={r.requestId} r={r} active={sel?.requestId === r.requestId} onClick={() => choose(r.requestId)} />
          ))}
        </section>

        <section className="crew2-detail">
          {pending.length > 0 && <NewRequests pending={pending} onShow={choose} />}
          {sel ? <Detail r={sel} tablet={tablet} viaHub={viaHub} /> : <p className="crew2-hint" lang="en">Select a request.</p>}
        </section>

        <section className="crew2-ann" aria-label="Announcement captions">
          <h2>
            <Megaphone aria-hidden /> アナウンス字幕 <span lang="en">Captions in every language</span>
          </h2>
          {ANNOUNCEMENTS.map((a) => (
            <button key={a.id} className={`crew2-annbtn${a.safety ? ' safety' : ''}`} onClick={() => tablet.announce(a.id)}>
              <span>{a.text.ja}</span>
              <small lang="en">{a.text.en}</small>
            </button>
          ))}
          {state.announcements[0] && (
            <p className="crew2-hint" lang="en">
              Last sent {ago(state.announcements[0].at)} ago.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** New requests that arrived while another one was open: shown here instead of switching the screen. */
function NewRequests({ pending, onShow }: { pending: CrewRequest[]; onShow: (id: string) => void }) {
  const first = pending[0]!;
  const urgent = isUrgentMedical(first.medical);
  const need = getNeed(first.needId);
  return (
    <div className={`crew2-newbar${urgent ? ' urgent' : ''}`} role={urgent ? 'alert' : 'status'}>
      <span className="crew2-newbar__text">
        <b>{pending.length > 1 ? `新しいリクエスト ${pending.length}件` : '新しいリクエスト'}</b>
        <span>
          {first.seat} · {first.medical ? '体調不良' : need?.label.ja}
          {urgent && <em lang="en"> URGENT</em>}
        </span>
        <small lang="en">{pending.length > 1 ? `${pending.length} new requests` : 'New request'} · {need?.label.en}</small>
      </span>
      <button className="crew2-btn" onClick={() => onShow(first.requestId)}>
        表示 <small lang="en">Show {first.seat}</small>
      </button>
    </div>
  );
}

/** Clearing every request cannot be undone, so ask first. */
function ConfirmReset({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="crew2-confirm" role="alertdialog" aria-labelledby="crew2-confirm-title" aria-describedby="crew2-confirm-body">
      <h2 id="crew2-confirm-title">
        すべてのリクエストを消去しますか？ <span lang="en">Clear all requests?</span>
      </h2>
      <p id="crew2-confirm-body" lang="en">
        {count === 1 ? '1 request' : `${count} requests`}, their replies and this flight's numbers are removed from every crew device. This cannot be undone.
      </p>
      <div className="crew2-confirm__actions">
        <button ref={cancelRef} className="crew2-btn ghost" onClick={onCancel}>
          キャンセル <small lang="en">Cancel</small>
        </button>
        <button className="crew2-btn" onClick={onConfirm}>
          消去 <small lang="en">Clear all</small>
        </button>
      </div>
    </div>
  );
}

/** Who sits here, before walking over: language, needs shared at check-in, this flight's requests. */
function SeatCard({ seat, requests, viaHub, onClose }: { seat: string; requests: CrewRequest[]; viaHub: boolean; onClose: () => void }) {
  const [booking, setBooking] = useState<PassengerProfile | null>(null);
  useEffect(() => {
    setBooking(null);
    if (!viaHub) return;
    let live = true;
    void lookupBookingOnHub(hubBaseUrl(), seat).then((p) => live && setBooking(p));
    return () => {
      live = false;
    };
  }, [seat, viaHub]);
  const mine = requests.filter((r) => r.seat === seat);
  const lang = booking?.lang ?? mine[0]?.lang;
  const tags = booking?.shareTagsWithCrew === false ? [] : (booking?.tags ?? mine[0]?.tags ?? []);
  return (
    <div className="crew2-seatcard" lang="en">
      <button className="crew2-icon" onClick={onClose} aria-label="Close seat details">
        <X aria-hidden />
      </button>
      <b>{seat}</b>
      {lang ? (
        <span>
          <span lang="ja">{LANG_JA[lang]}</span> · {languageInfo(lang).englishName}
        </span>
      ) : (
        <span>No booking details</span>
      )}
      {tags.length > 0 && (
        <span>
          {tags.map((tag) => (
            <em key={tag} lang="ja">
              {tagJa(tag)} <small lang="en">{tagEn(tag)}</small>
            </em>
          ))}
        </span>
      )}
      <span>
        {mine.length} request{mine.length === 1 ? '' : 's'} this flight
        {mine.length > 0 && `: ${mine.map((r) => getNeed(r.needId)?.label.en ?? r.needId).join(', ')}`}
      </span>
    </div>
  );
}

function Metric({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`crew2-metric${alert ? ' alert' : ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function Heard({ e }: { e: Extract<HubEvent, { type: 'understood' }> }) {
  const need = e.match ? getNeed(e.match) : undefined;
  return (
    <div className="crew2-heard" lang="en">
      <span className="crew2-heard__label">
        <Activity aria-hidden /> {e.asrMs > 0 ? `Last heard (${languageName(e.lang)}, ${(e.asrMs / 1000).toFixed(1)} s)` : `Last typed (${languageName(e.lang)})`}
      </span>
      <q lang={e.lang}>{e.transcript}</q>
      {need && (
        <span>
          → {need.label.en} · {Math.round(e.confidence * 100)}%
        </span>
      )}
    </div>
  );
}

function SourceBadge({ r }: { r: CrewRequest }) {
  const Icon = r.source === 'speech' ? Mic : r.source === 'typed' ? Keyboard : MousePointerClick;
  const label = r.source === 'speech' ? 'spoken' : r.source === 'typed' ? 'typed' : 'tapped';
  return (
    <span className="crew2-badge" lang="en">
      <Icon aria-hidden /> {label}
      {r.understanding?.viaPictures ? ' · picked from pictures' : ''}
    </span>
  );
}

function RequestCard({ r, active, onClick }: { r: CrewRequest; active: boolean; onClick: () => void }) {
  const need = getNeed(r.needId);
  const urgent = r.status === 'new' && isUrgentMedical(r.medical);
  return (
    <button className={`crew2-card s-${r.status}${active ? ' active' : ''}${urgent ? ' urgent' : ''}`} onClick={onClick}>
      <span className="crew2-card__seat">{r.seat}</span>
      <span className="crew2-card__icon">{need && <NeedIcon name={r.medical ? 'stethoscope' : need.icon} size="100%" />}</span>
      <span className="crew2-card__text">
        <b>
          {need?.private && <Lock aria-label="private" />} {need?.label.ja}
        </b>
        <small lang="en">
          {need?.label.en}
          {r.purposeId ? ` · ${getPurpose(r.purposeId)?.label.en}` : ''}
        </small>
      </span>
      <span className="crew2-card__meta" lang="en">
        <span className="crew2-lang">{r.spokenLang ? languageName(r.spokenLang) : LANG_JA[r.lang]}</span>
        <span className={`crew2-age${r.status === 'new' && Date.now() - r.receivedAt > 60_000 ? ' late' : ''}`}>{r.status === 'new' ? ago(r.receivedAt) : r.status === 'replied' ? 'answered' : r.status}</span>
      </span>
    </button>
  );
}

function Detail({ r, tablet, viaHub }: { r: CrewRequest; tablet: CrewTabletApi; viaHub: boolean }) {
  const need = getNeed(r.needId);
  const purpose = getPurpose(r.purposeId);
  const suggested = r.medical ? (isUrgentMedical(r.medical) ? 'doctor_coming' : 'coming_to_seat') : defaultReplyFor(r.needId);
  return (
    <div className="crew2-d" aria-live="polite">
      <div className="crew2-d__head">
        <span className="crew2-d__seat">{r.seat}</span>
        <span className="crew2-d__ago" lang="en">
          received {ago(r.receivedAt)} ago
          {r.reply ? ` · answered in ${formatDuration(r.reply.at - r.receivedAt)}` : ''}
        </span>
      </div>
      <div className="crew2-d__need">
        {need && (
          <span className="crew2-d__icon">
            <NeedIcon name={need.icon} size="100%" />
          </span>
        )}
        <div>
          <div className="crew2-d__ja">
            {need?.private && <Lock aria-label="private" />} {need?.label.ja}
          </div>
          <div className="crew2-d__en" lang="en">
            {need?.label.en}
          </div>
          {purpose && (
            <div className="crew2-d__purpose">
              {purpose.label.ja} <span lang="en">· {purpose.label.en}</span>
            </div>
          )}
        </div>
      </div>

      {r.medical && (
        <div className={`crew2-med${isUrgentMedical(r.medical) ? ' urgent' : ''}`}>
          <div className="crew2-med__title">
            <Stethoscope aria-hidden /> 体調不良 · Care Mode
            {isUrgentMedical(r.medical) && <b lang="en">URGENT</b>}
          </div>
          <ul>
            {medicalSummaryLines(r.medical, 'ja').map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <ul lang="en" className="en">
            {medicalSummaryLines(r.medical, 'en').map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <button className="crew2-btn" onClick={() => tablet.announce('doctor_call')}>
            <Megaphone aria-hidden /> 医師の呼び出し字幕 <small lang="en">Ask for a doctor (captions, all languages)</small>
          </button>
          <button className="crew2-btn ghost" onClick={() => openMedicalHandover(r, tablet.getState())}>
            <Printer aria-hidden /> 引き継ぎ書 <small lang="en">Handover sheet for the doctor / ground team (JA + EN)</small>
          </button>
        </div>
      )}

      <div className="crew2-tags">
        <span className="crew2-tag lang">
          {r.spokenLang ? (
            <span lang="en">
              {languageName(r.spokenLang)} (language pack) · replies in {languageInfo(r.lang).englishName}
            </span>
          ) : (
            <>
              {LANG_JA[r.lang]} <span lang="en">{languageInfo(r.lang).englishName}</span>
            </>
          )}
        </span>
        {r.tags.map((tag) => (
          <span key={tag} className="crew2-tag">
            {tagJa(tag)} <span lang="en">{tagEn(tag)}</span>
          </span>
        ))}
        <SourceBadge r={r} />
        <span className="crew2-badge" lang="en">
          {r.device === 'ife' ? 'seatback screen' : 'phone'}
        </span>
      </div>
      {r.status === 'cancelled' && <p className="crew2-note">取り消されました · Cancelled by passenger</p>}
      {r.status === 'thanked' && <p className="crew2-note ok">ありがとう ♥ · Passenger said thank you</p>}

      {viaHub && r.status !== 'cancelled' && <VoiceReply r={r} tablet={tablet} />}

      <div className="crew2-replies">
        {REPLIES.map((rep) => (
          <button
            key={rep.id}
            className={`crew2-reply t-${rep.tone}${r.reply?.replyId === rep.id ? ' chosen' : ''}${rep.id === suggested && !r.reply ? ' suggested' : ''}`}
            disabled={r.status === 'cancelled'}
            onClick={() => tablet.reply(r.requestId, rep.id)}
          >
            <span>{rep.text.ja}</span>
            <small lang="en">{rep.text.en}</small>
          </button>
        ))}
      </div>
      <p className="crew2-preview" lang="en">
        Passenger sees ({languageInfo(r.lang).englishName}{r.reply?.message ? ', machine-translated' : ''}):{' '}
        <q lang={languageInfo(r.lang).bcp47}>{r.reply?.message ? r.reply.message.text : replyTextOf(getReply(r.reply?.replyId ?? suggested), r.lang)}</q>
      </p>
    </div>
  );
}

/** Crew speak Japanese; the hub matches it to the closest verified reply, which crew confirm with one tap. */
function VoiceReply({ r, tablet }: { r: CrewRequest; tablet: CrewTabletApi }) {
  const rec = useRef(new MicRecorder());
  const [phase, setPhase] = useState<'idle' | 'listening' | 'thinking'>('idle');
  const [result, setResult] = useState<{ transcript: string; replyId: ReplyId | null; confidence: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ p: UnderstandProgress; since: number } | null>(null);
  const [ownWords, setOwnWords] = useState<string | null>(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (phase !== 'thinking') return;
    const t = setInterval(() => redraw((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => {
    setResult(null);
    setError(null);
    setOwnWords(null);
  }, [r.requestId]);
  useEffect(() => () => rec.current.cancel(), []);

  const start = async () => {
    setError(null);
    setResult(null);
    try {
      await rec.current.start(() => undefined, () => void finish());
      setPhase('listening');
    } catch (e) {
      setError(e instanceof MicUnavailableError && e.reason === 'insecure' ? 'Microphone needs HTTPS or localhost.' : 'Microphone not available.');
    }
  };
  const finish = async () => {
    setPhase('thinking');
    setProgress(null);
    try {
      const res = await recordAndUnderstand(rec.current, hubBaseUrl(), 'ja', 'replies', (p) => setProgress({ p, since: Date.now() }));
      setResult({ transcript: res.transcript, replyId: res.reply?.replyId ?? null, confidence: res.reply?.confidence ?? 0 });
      setOwnWords(res.transcript);
    } catch {
      setError('Could not understand. Tap a reply instead.');
    }
    setPhase('idle');
  };
  const matched = result?.replyId && result.confidence >= REPLY_SUGGEST_MIN ? getReply(result.replyId) : null;
  return (
    <div className="crew2-voice">
      <button className={`crew2-mic${phase === 'listening' ? ' on' : ''}`} onClick={phase === 'listening' ? () => void finish() : () => void start()} disabled={phase === 'thinking'}>
        {phase === 'listening' ? <Square aria-hidden /> : <Mic aria-hidden />}
        {phase === 'listening' ? '話し終わったらタップ · Tap when done' : phase === 'thinking' ? thinkingText(progress) : '日本語で話して返信 · Reply by voice'}
      </button>
      {phase === 'thinking' && progress?.p.stage === 'matching' && (
        <p className="crew2-note">
          聞き取り · Heard: <q>{progress.p.transcript}</q>
        </p>
      )}
      {error && (
        <p className="crew2-note" lang="en">
          {error}
        </p>
      )}
      {result && (
        <div className="crew2-voice__result">
          <q>{result.transcript || '…'}</q>
          {matched ? (
            <button className="crew2-reply t-positive suggested" onClick={() => tablet.reply(r.requestId, matched.id)}>
              <span>{matched.text.ja}</span>
              <small lang="en">
                Send verified reply ({Math.round(result.confidence * 100)}% match) → {replyTextOf(matched, r.lang)}
              </small>
            </button>
          ) : (
            <p className="crew2-note" lang="en">
              No verified reply matched closely enough. Tap a checked reply below, or send your own words (machine-translated).
            </p>
          )}
        </div>
      )}
      {ownWords === null ? (
        <button className="crew2-own__open" onClick={() => setOwnWords('')}>
          自分の言葉で書く · Type your own words
        </button>
      ) : (
        <OwnWords key={result?.transcript ?? ''} r={r} tablet={tablet} initial={ownWords} />
      )}
    </div>
  );
}

/**
 * The crew member's own words, translated offline on the hub (NLLB-200) and
 * sent only after the crew member has seen the translation. The passenger is
 * told it is machine-translated: unlike the verified replies, nobody checked it.
 */
function OwnWords({ r, tablet, initial }: { r: CrewRequest; tablet: CrewTabletApi; initial: string }) {
  const [text, setText] = useState(initial);
  const [translated, setTranslated] = useState<{ source: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang = languageInfo(r.lang);
  // Load the translation model while the crew member is still typing or speaking.
  useEffect(() => {
    void fetch(`${hubBaseUrl()}/api/translate/warm`, { method: 'POST' }).catch(() => undefined);
  }, []);
  const translate = async () => {
    const source = text.trim();
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${hubBaseUrl()}/api/translate`, { method: 'POST', body: JSON.stringify({ text: source, from: 'ja', to: r.lang }) });
      const body = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || !body.text) throw new Error(body.error ?? 'translation failed');
      setTranslated({ source, text: body.text });
    } catch (e) {
      setError(`Could not translate: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(false);
  };
  const fresh = translated && translated.source === text.trim();
  return (
    <div className="crew2-own">
      <label className="crew2-own__label" lang="en">
        自分の言葉 · Your own words (Japanese)
        <textarea value={text} maxLength={300} rows={2} onChange={(e) => setText(e.target.value)} placeholder="例: 毛布をすぐにお持ちします" />
      </label>
      <button className="crew2-own__btn" disabled={busy || !text.trim()} onClick={() => void translate()}>
        {busy ? '翻訳中… · Translating…' : `${lang.englishName}に翻訳 · Translate to ${lang.englishName}`}
      </button>
      {error && (
        <p className="crew2-note" lang="en">
          {error}
        </p>
      )}
      {fresh && (
        <div className="crew2-own__preview">
          <small lang="en">Passenger will see (machine-translated, not checked):</small>
          <q lang={lang.bcp47}>{translated.text}</q>
          <button className="crew2-reply t-positive" onClick={() => tablet.sendMessage(r.requestId, { original: translated.source, text: translated.text, lang: r.lang })}>
            <span>この訳を送る</span>
            <small lang="en">Send this translation</small>
          </button>
        </div>
      )}
    </div>
  );
}

/** Crew see the same honest wait as passengers: queued, Whisper with the time left, then matching. */
function thinkingText(progress: { p: UnderstandProgress; since: number } | null): string {
  const p = progress?.p;
  if (p?.stage === 'queued') return '順番待ち… · Another request first…';
  if (p?.stage === 'transcribing' && progress) {
    const left = Math.ceil((p.estimateMs - (Date.now() - progress.since)) / 1000);
    return left >= 1 ? `認識中… あと約${left}秒 · Understanding… ~${left} s` : 'まもなく… · Almost done…';
  }
  if (p?.stage === 'matching') return '返信を照合中… · Matching a verified reply…';
  return '認識中… · Understanding…';
}
