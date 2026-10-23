/**
 * Offline translation with NLLB-200 (`npm run models -- translate`, ~900 MB
 * once): the crew member's own words, when no verified reply fits. Unlike the
 * verified replies nobody has checked these, so the passenger is told the
 * message is machine-translated.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTransformers } from './ai';
import { MODEL_DIR, TRANSLATE_MODEL } from './models';

/** NLLB-200 codes for the languages HearMe reads. */
export const NLLB_CODES: Record<string, string> = {
  ja: 'jpn_Jpan',
  en: 'eng_Latn',
  hi: 'hin_Deva',
  th: 'tha_Thai',
  id: 'ind_Latn',
  vi: 'vie_Latn',
  bn: 'ben_Beng',
  ta: 'tam_Taml',
  pa: 'pan_Guru',
  mr: 'mar_Deva',
};

export interface Translator {
  translate(text: string, from: string, to: string): Promise<string>;
}

/**
 * Keep the translation proper: stop at the first word in another script
 * (non-Latin targets) and drop words repeated back to back.
 */
export function keepTarget(text: string, script: string): string {
  const own = new RegExp(`\\p{Script=${script}}`, 'u');
  const letter = /\p{L}/u;
  const kept: string[] = [];
  for (const word of text.trim().split(/\s+/)) {
    if (script !== 'Latn' && letter.test(word) && !own.test(word)) break;
    if (word === '-' || word === kept[kept.length - 1]) continue;
    kept.push(word);
  }
  return kept.join(' ');
}

export function translationModelInstalled(): boolean {
  return existsSync(join(MODEL_DIR, TRANSLATE_MODEL, 'onnx'));
}

export async function createNllb(threads: number): Promise<Translator> {
  if (!translationModelInstalled()) throw new Error('translation model not installed: npm run models -- translate');
  const t = await loadTransformers();
  const run = (await t.pipeline('translation', TRANSLATE_MODEL, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  } as never)) as unknown as (texts: string[], opts: Record<string, unknown>) => Promise<{ translation_text: string }[]>;
  return {
    async translate(text, from, to) {
      const src = NLLB_CODES[from];
      const tgt = NLLB_CODES[to];
      if (!src || !tgt) throw new Error(`no translation for ${from} → ${to}`);
      // One sentence at a time: batched generation runs on past the end of shorter sentences.
      const sentences = text.split(/(?<=[。！？!?])\s*/u).filter((s) => s.trim());
      const out: string[] = [];
      for (const s of sentences) {
        const [r] = await run([s], { src_lang: src, tgt_lang: tgt, max_new_tokens: 96 });
        out.push(keepTarget(r?.translation_text ?? '', tgt.split('_')[1]!));
      }
      return out.filter(Boolean).join(' ');
    },
  };
}
