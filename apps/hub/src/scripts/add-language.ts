/**
 * Adds a language for understanding requests, from a data file:
 *
 *   npm run add-language -w @hearme/hub -- bn            use data/languages/bn.json
 *   npm run add-language -w @hearme/hub -- ta --draft    draft data/languages/ta.json first, offline
 *
 * 1. --draft: translates the English catalogue (labels, keywords and a few
 *    example requests per need) with NLLB-200 on this laptop (npm run models
 *    -- translate, ~900 MB once). The draft is marked "machine": it is only
 *    used to *understand* requests, never shown to passengers, and needs a
 *    native speaker's review.
 * 2. checks the pack covers the 40 needs,
 * 3. retrains the need classifier with it and measures typed requests
 *    (zeroshot.ts), then tells a running hub to load it (no restart).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEEDS, languageName } from '@hearme/shared';
import { loadTransformers } from '../ai';
import { PACK_DIR, checkPack, type LanguagePack } from '../langpacks';
import { TRANSLATE_MODEL, inferenceThreads } from '../models';
import { keepTarget } from '../translate';

/** NLLB-200 and Whisper names for languages likely on India / South-East Asia routes. */
const LANGS: Record<string, { nllb: string; whisper?: string }> = {
  bn: { nllb: 'ben_Beng', whisper: 'bengali' },
  ta: { nllb: 'tam_Taml', whisper: 'tamil' },
  te: { nllb: 'tel_Telu', whisper: 'telugu' },
  ml: { nllb: 'mal_Mlym', whisper: 'malayalam' },
  kn: { nllb: 'kan_Knda', whisper: 'kannada' },
  mr: { nllb: 'mar_Deva', whisper: 'marathi' },
  gu: { nllb: 'guj_Gujr', whisper: 'gujarati' },
  pa: { nllb: 'pan_Guru', whisper: 'punjabi' },
  ur: { nllb: 'urd_Arab', whisper: 'urdu' },
  ne: { nllb: 'npi_Deva', whisper: 'nepali' },
  si: { nllb: 'sin_Sinh', whisper: 'sinhala' },
  tl: { nllb: 'tgl_Latn', whisper: 'tagalog' },
  ms: { nllb: 'zsm_Latn', whisper: 'malay' },
  my: { nllb: 'mya_Mymr', whisper: 'myanmar' },
  km: { nllb: 'khm_Khmr', whisper: 'khmer' },
  lo: { nllb: 'lao_Laoo', whisper: 'lao' },
  ko: { nllb: 'kor_Hang', whisper: 'korean' },
  zh: { nllb: 'zho_Hans', whisper: 'chinese' },
};

async function draft(code: string): Promise<LanguagePack> {
  const lang = LANGS[code];
  if (!lang) throw new Error(`No translation code for "${code}". Known: ${Object.keys(LANGS).join(', ')}`);
  console.log(`▶ Drafting ${languageName(code)} with NLLB-200 (offline) …`);
  const t = await loadTransformers();
  const translate = (await t.pipeline('translation', TRANSLATE_MODEL, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    session_options: { intraOpNumThreads: inferenceThreads(), interOpNumThreads: 1 },
  } as never)) as unknown as (texts: string[], opts: Record<string, unknown>) => Promise<{ translation_text: string }[]>;
  const script = lang.nllb.split('_')[1]!;
  const needs: Record<string, string[]> = {};
  const examples: Record<string, string[]> = {};
  for (const need of NEEDS) {
    const label = need.label.en;
    const lower = label.charAt(0).toLowerCase() + label.slice(1);
    const isThing = !/^(I |My |How |Help |Please |Talk |Someone )/.test(label);
    const words = [...new Set([label, ...(need.phrases.en ?? []).slice(0, 3)])];
    const sentences = isThing ? [`I need ${lower}.`, `Can I have ${lower}, please?`] : [`Excuse me, ${lower}.`];
    // One text at a time: batched generation runs on past the end of shorter sentences.
    const out: string[] = [];
    for (const text of [...words, ...sentences]) {
      const [r] = await translate([text], { src_lang: 'eng_Latn', tgt_lang: lang.nllb, max_new_tokens: 40 });
      out.push(keepTarget(r?.translation_text ?? '', script));
    }
    const clean = (s: string) => s.replace(/[.!?。।]+$/u, '').trim();
    needs[need.id] = [...new Set(out.slice(0, words.length).map(clean))].filter((w) => w && w.length <= 40);
    examples[need.id] = out.slice(words.length).filter(Boolean);
    process.stdout.write('.');
  }
  console.log();
  return {
    code,
    name: languageName(code),
    ...(lang.whisper ? { whisper: lang.whisper } : {}),
    script,
    draft: 'machine',
    note: 'Drafted offline by NLLB-200 from the English catalogue. Used only to understand requests, never shown to passengers. Needs native review.',
    templates: ['{k}'],
    needs,
    examples,
  };
}

const code = process.argv[2];
if (!code || !/^[a-z]{2,3}$/.test(code)) {
  console.log('Usage: npm run add-language -w @hearme/hub -- <code> [--draft]');
  process.exit(1);
}
const file = join(PACK_DIR, `${code}.json`);
if (process.argv.includes('--draft')) {
  if (existsSync(file)) console.log(`${file} already exists: keeping it (delete it to draft again).`);
  else writeFileSync(file, `${JSON.stringify(await draft(code), null, 2)}\n`);
}
if (!existsSync(file)) {
  console.log(`No ${file}. Write one by hand, or add --draft to draft it offline.`);
  process.exit(1);
}
const pack = JSON.parse(readFileSync(file, 'utf8')) as LanguagePack;
const { missing, unknown } = checkPack(pack);
console.log(`▶ ${pack.name} (${pack.code}, ${pack.draft ?? 'human'} draft): ${NEEDS.length - missing.length}/${NEEDS.length} needs have keywords${pack.whisper ? ', speech via Whisper' : ', typing only'}`);
if (missing.length) console.log(`  missing: ${missing.join(', ')}`);
if (unknown.length) console.log(`  not needs (ignored): ${unknown.join(', ')}`);

const hub = fileURLToPath(new URL('../../', import.meta.url));
for (const script of ['train-head.ts', 'zeroshot.ts']) {
  const r = spawnSync('npx', ['tsx', `src/scripts/${script}`], { cwd: hub, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
// A running hub picks the language up without a restart.
const reloaded = await fetch('http://localhost:8080/api/languages/reload', { method: 'POST' }).then((r) => r.ok, () => false);
console.log(reloaded ? '▶ The running hub now understands it.' : '▶ Start the hub (npm run demo) to use it.');
