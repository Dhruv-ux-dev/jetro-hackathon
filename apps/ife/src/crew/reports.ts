import {
  ANNOUNCEMENTS,
  computeCrewMetrics,
  formatDuration,
  getNeed,
  getReply,
  isUrgentMedical,
  languageInfo,
  medicalSummaryLines,
  t,
  type CrewRequest,
  type CrewTabletState,
} from '@hearme/shared';

/**
 * Printable pages for the crew: a medical handover for the ground team and a
 * post-flight report. Each opens in its own window with a Print / Save as PDF
 * button. Prototype records, not clinical or operational documents.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
const LANG_JA: Record<string, string> = { hi: 'ヒンディー語', en: '英語', ja: '日本語', th: 'タイ語', id: 'インドネシア語', vi: 'ベトナム語' };

const CSS = `
  body { font: 15px/1.5 "Noto Sans", "Hiragino Sans", system-ui, sans-serif; color: #12213f; margin: 32px auto; max-width: 760px; padding: 0 20px; }
  h1 { font-size: 24px; margin: 0 0 2px; } h1 span { color: #e0603a; }
  h2 { font-size: 16px; margin: 22px 0 6px; border-bottom: 2px solid #e6ebf3; padding-bottom: 4px; }
  .sub { color: #5b6b8a; margin: 0 0 18px; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e6ebf3; vertical-align: top; }
  th { width: 34%; color: #42506d; font-weight: 600; }
  .urgent { color: #b42318; font-weight: 800; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .tiles div { background: #f3f6fb; border-radius: 10px; padding: 10px; } .tiles b { display: block; font-size: 22px; }
  .print { margin-top: 26px; padding: 10px 18px; border-radius: 999px; border: 0; background: #12213f; color: #fff; font: inherit; cursor: pointer; }
  @media print { .print { display: none; } body { margin: 0; } }
`;

function openPrintable(title: string, body: string): void {
  const w = window.open('', '_blank', 'width=840,height=1000');
  if (!w) return;
  w.document.write(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}` +
      `<button class="print" onclick="print()">Print / Save as PDF</button></body></html>`,
  );
  w.document.close();
}

/** One page the cabin crew hand to the doctor on board or the ground medical team. */
export function openMedicalHandover(r: CrewRequest, state: CrewTabletState): void {
  if (!r.medical) return;
  const urgent = isUrgentMedical(r.medical);
  const doctorCall = state.announcements.find((a) => a.templateId === 'doctor_call' && a.at >= r.receivedAt);
  const actions = [
    ...(r.reply?.replyId ? [`${time(r.reply.at)} 返信 Reply: ${getReply(r.reply.replyId).text.ja} / ${getReply(r.reply.replyId).text.en}`] : []),
    ...(r.reply?.message ? [`${time(r.reply.at)} 返信 Own words (machine-translated): ${r.reply.message.original} → ${r.reply.message.text}`] : []),
    ...(doctorCall ? [`${time(doctorCall.at)} 医師の呼び出し Doctor call captioned on every seat`] : []),
  ];
  openPrintable(
    `Medical handover ${r.seat}`,
    `<h1>医療引き継ぎ <span>·</span> Medical handover</h1>
     <p class="sub">HearMe · prototype record from the passenger's own report. Not a clinical document.</p>
     <table>
       <tr><th>座席 Seat</th><td><b>${esc(r.seat)}</b></td></tr>
       <tr><th>言語 Language</th><td>${esc(LANG_JA[r.lang] ?? r.lang)} · ${esc(languageInfo(r.lang).englishName)}</td></tr>
       <tr><th>報告 Reported</th><td>${time(r.receivedAt)}</td></tr>
       <tr><th>緊急度 Urgency</th><td>${urgent ? '<span class="urgent">緊急 URGENT</span>' : '通常 Not flagged urgent'}</td></tr>
       ${r.tags.length ? `<tr><th>配慮 Needs</th><td>${esc(r.tags.map((tag) => `${t('ja', `tag.${tag}`)} (${t('en', `tag.${tag}`)})`).join(', '))}</td></tr>` : ''}
     </table>
     <h2>日本語</h2>${list(medicalSummaryLines(r.medical, 'ja'))}
     <h2>English</h2>${list(medicalSummaryLines(r.medical, 'en'))}
     ${r.lang !== 'en' && r.lang !== 'ja' ? `<h2>${esc(languageInfo(r.lang).englishName)} (as the passenger saw it)</h2>${list(medicalSummaryLines(r.medical, r.lang))}` : ''}
     <h2>対応 Actions</h2>${actions.length ? list(actions) : '<p>None recorded yet.</p>'}`,
  );
}

/** Post-flight summary: how many asked, for what, in which languages, how fast the answers came. */
export function openFlightReport(state: CrewTabletState): void {
  const m = computeCrewMetrics(state.requests);
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const byNeed = new Map<string, number>();
  for (const r of state.requests) byNeed.set(r.needId, (byNeed.get(r.needId) ?? 0) + 1);
  const needs = [...byNeed.entries()].sort((a, b) => b[1] - a[1]);
  const open = state.requests.filter((r) => r.status === 'new');
  const medical = state.requests.filter((r) => r.medical);
  const ann = new Map<string, number>();
  for (const a of state.announcements) ann.set(a.templateId, (ann.get(a.templateId) ?? 0) + 1);
  const row = (a: string, b: string) => `<tr><th>${a}</th><td>${b}</td></tr>`;
  openPrintable(
    'Flight report',
    `<h1>フライトレポート <span>·</span> Flight report</h1>
     <p class="sub">HearMe · ${new Date().toLocaleString()} · prototype summary of this console's requests</p>
     <div class="tiles">
       <div><b>${m.total}</b>requests</div>
       <div><b>${formatDuration(m.medianAnswerMs)}</b>median answer</div>
       <div><b>${pct(m.firstTimeRate)}</b>understood 1st time</div>
       <div><b>${m.medical}</b>medical</div>
     </div>
     <h2>What passengers asked for</h2>
     <table>${needs.map(([id, n]) => row(esc(`${getNeed(id)?.label.ja ?? id} · ${getNeed(id)?.label.en ?? ''}`), String(n))).join('') || row('—', '0')}</table>
     <h2>Languages</h2>
     <table>${Object.entries(m.byLang).map(([l, n]) => row(esc(`${LANG_JA[l] ?? l} · ${languageInfo(l as never).englishName}`), String(n))).join('') || row('—', '0')}</table>
     <h2>Quality</h2>
     <table>
       ${row('Answered', `${m.answered} of ${m.total}`)}
       ${row('Needed "Did you mean?" pictures', pct(m.pictureRate))}
       ${row('Still open', open.length ? esc(open.map((r) => `${r.seat} (${getNeed(r.needId)?.label.en ?? r.needId}, ${time(r.receivedAt)})`).join(', ')) : 'none')}
       ${row('Medical reports', medical.length ? esc(medical.map((r) => `${r.seat}${isUrgentMedical(r.medical) ? ' URGENT' : ''} ${time(r.receivedAt)}`).join(', ')) : 'none')}
     </table>
     <h2>Captions sent</h2>
     <table>${[...ann.entries()].map(([id, n]) => row(esc(ANNOUNCEMENTS.find((a) => a.id === id)?.text.en ?? id), String(n))).join('') || row('—', '0')}</table>`,
  );
}
