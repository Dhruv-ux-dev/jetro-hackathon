import {
  ReplyMatcher,
  SemanticNeedMatcher,
  createKeywordMatcher,
  type Embedder,
  findLanguage,
  type LangCode,
  type MatchResult,
  type ModelState,
  type ReplyId,
  type UnderstoodRequests,
  mayHoldSeveral,
  understandRequests,
} from '@hearme/shared';
import { loadNeedHead } from './head';
import { fromDevanagari, loadLanguagePacks, withLanguagePacks, type LanguagePack } from './langpacks';
import { ASR_MODELS, EMBED_MODEL, MODEL_DIR, type AsrSize } from './models';
import { createNllb, type Translator } from './translate';

/**
 * The crew tablet's offline AI: Whisper for speech → text and
 * multilingual-e5 for text → need / verified reply. Models load from disk
 * (download once with `npm run models`). Requests run one at a time so a
 * laptop stays responsive; nothing is written to disk.
 */

export interface Transcriber {
  /**
   * `lang`: one of the 6 language codes, or Whisper's name for another language (e.g. "bengali").
   * `maxNewTokens` caps decoding (the warm-up uses a few tokens; requests use up to 64).
   */
  transcribe(samples: Float32Array, lang: string, opts?: { maxNewTokens?: number }): Promise<string>;
  /** Frees the model's memory (used when switching models). */
  dispose?(): Promise<void>;
}

/** Whisper's name for a language HearMe offers; anything else is passed through unchanged. */
const whisperLang = (lang: string): string => findLanguage(lang)?.whisper ?? lang;

/** Whisper invents text for silence ("Thank you." …); skip clips with no speech. */
export function hasSpeech(samples: Float32Array, sampleRate = 16000): boolean {
  return trimSilence(samples, sampleRate) !== null;
}

/**
 * The part of a clip between the first and last voiced 20 ms frame (plus a
 * quarter second either side), or null with under 0.25 s of speech. Long
 * silent tails are where Whisper hallucinates; it does not make Whisper
 * faster, which always encodes a 30 s window.
 */
export function trimSilence(samples: Float32Array, sampleRate = 16000): Float32Array | null {
  const frame = Math.round(sampleRate * 0.02);
  let voiced = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j]! * samples[j]!;
    if (Math.sqrt(sum / frame) > 0.01) {
      voiced += 1;
      if (first < 0) first = i;
      last = i + frame;
    }
  }
  if (voiced * 0.02 < 0.25) return null;
  const pad = Math.round(sampleRate * 0.25);
  return samples.subarray(Math.max(0, first - pad), Math.min(samples.length, last + pad));
}

/** Rejects when the work takes too long, so one stuck request cannot block the queue. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    work.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e)),
    );
  });
}

export async function loadTransformers() {
  const t = await import('@huggingface/transformers');
  t.env.cacheDir = MODEL_DIR;
  t.env.localModelPath = MODEL_DIR;
  t.env.allowRemoteModels = false;
  return t;
}

export async function createWhisper(size: AsrSize, threads: number): Promise<Transcriber> {
  const t = await loadTransformers();
  const asr = await t.pipeline('automatic-speech-recognition', ASR_MODELS[size], {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  });
  return {
    async transcribe(samples, lang, opts) {
      // Long clips are cut to 20 s: requests are short, and this bounds the work per request.
      const clip = samples.length > 16000 * 20 ? samples.subarray(0, 16000 * 20) : samples;
      const out = (await asr(clip, { language: whisperLang(lang), task: 'transcribe', max_new_tokens: opts?.maxNewTokens ?? 64 })) as { text: string };
      return out.text.trim();
    },
    dispose: () => asr.dispose(),
  };
}

export async function createE5(threads: number): Promise<Embedder> {
  const t = await loadTransformers();
  const extractor = await t.pipeline('feature-extraction', EMBED_MODEL, {
    dtype: 'q8',
    session_options: { intraOpNumThreads: Math.min(2, threads), interOpNumThreads: 1 },
  });
  return {
    async embed(texts, kind) {
      const out: Float32Array[] = [];
      // Small batches keep memory flat while the index is built.
      for (let i = 0; i < texts.length; i += 32) {
        const batch = texts.slice(i, i + 32).map((x) => `${kind}: ${x}`);
        const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
        const [rows, dims] = tensor.dims as [number, number];
        const data = tensor.data as Float32Array;
        for (let r = 0; r < rows; r++) out.push(data.slice(r * dims, (r + 1) * dims));
      }
      return out;
    },
  };
}

/**
 * A deterministic, speech-like practice clip for warming Whisper up: a
 * gliding voice pitch with harmonics, chopped into syllables. It never leaves
 * the hub and its transcript is thrown away. The first inference of an ONNX
 * session is several times slower than the rest (memory arenas, kernel
 * selection); doing it at start-up means the first passenger does not pay for it.
 */
export function warmupClip(seconds = 2, rate = 16000): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f0 = 125 + 25 * Math.sin(2 * Math.PI * 0.8 * t);
    phase += (2 * Math.PI * f0) / rate;
    let v = 0;
    for (let h = 1; h <= 10; h++) {
      const f = f0 * h;
      // Two broad "formant" bumps around 700 Hz and 1.2 kHz.
      const formant = Math.exp(-(((f - 700) / 300) ** 2)) + 0.7 * Math.exp(-(((f - 1200) / 400) ** 2)) + 0.15;
      v += (formant * Math.sin(h * phase)) / h;
    }
    const syllables = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
    out[i] = 0.12 * v * syllables;
  }
  return out;
}

/**
 * One short request per language: warms the tokenizer, the e5 index lookup and
 * the trained classifier. Every language HearMe offers is warmed, so a
 * Punjabi passenger's first request is no slower than a Hindi one.
 */
const WARMUP_PHRASES: Record<LangCode, string> = {
  hi: 'मुझे पानी चाहिए',
  en: 'I need some water',
  ja: 'お水をください',
  th: 'ขอน้ำหน่อย',
  id: 'Minta air putih',
  vi: 'Cho tôi nước',
  bn: 'আমার জল লাগবে',
  ta: 'எனக்கு தண்ணீர் வேண்டும்',
  pa: 'ਮੈਨੂੰ ਪਾਣੀ ਚਾਹੀਦਾ ਹੈ',
  mr: 'मला पाणी पाहिजे',
};

export interface ModelStatus {
  model: string;
  state: ModelState;
  error?: string;
  /** How long the warm-up run took. */
  warmupMs?: number;
  /** Median of recent real runs. */
  typicalMs?: number;
}

export interface AiStatus {
  asr: ModelStatus;
  embed: ModelStatus;
}

/** Called while a recording waits for and then goes through Whisper. */
export interface TranscribeHooks {
  /** Other jobs are ahead of this one on the hub. */
  onQueued?(ahead: number): void;
  /** Whisper has started on this recording; `estimateMs` is the typical time. */
  onStart?(estimateMs: number): void;
}

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]!);
};

export interface AiEngineOptions {
  asrSize: AsrSize;
  threads: number;
  /** Factories are injectable for tests. */
  loadAsr?: () => Promise<Transcriber>;
  loadEmbedder?: () => Promise<Embedder>;
  loadTranslator?: () => Promise<Translator>;
}

export class AiEngine {
  private asr: Transcriber | null = null;
  private needs: SemanticNeedMatcher | null = null;
  private replies: ReplyMatcher | null = null;
  private packs = loadLanguagePacks();
  private keyword = createKeywordMatcher(withLanguagePacks(undefined, this.packs));
  private embedder: Embedder | null = null;
  private translator: Promise<Translator> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private asrFailures = 0;
  private asrTimes: number[] = [];
  private matchTimes: number[] = [];
  readonly status: AiStatus;

  constructor(private options: AiEngineOptions) {
    this.status = {
      asr: { model: ASR_MODELS[options.asrSize], state: 'off' },
      embed: { model: EMBED_MODEL, state: 'off' },
    };
  }

  /**
   * Load models one after the other (lower peak memory), then warm each one up
   * with a practice run so the first passenger request is as fast as the rest.
   * Requests that arrive meanwhile wait in the queue. Never throws.
   */
  async start(): Promise<void> {
    this.status.embed.state = 'loading';
    try {
      const embedder = await (this.options.loadEmbedder ?? (() => createE5(this.options.threads)))();
      this.embedder = embedder;
      this.needs = await SemanticNeedMatcher.create(embedder, withLanguagePacks(undefined, this.packs), loadNeedHead());
      this.replies = await ReplyMatcher.create(embedder);
      this.status.embed.state = 'warming';
      await this.warmEmbed();
      this.status.embed.state = 'ready';
    } catch (e) {
      this.status.embed = { ...this.status.embed, state: this.needs ? 'ready' : 'error', error: String(e) };
    }
    this.status.asr.state = 'loading';
    let asr: Transcriber;
    try {
      asr = await (this.options.loadAsr ?? (() => createWhisper(this.options.asrSize, this.options.threads)))();
    } catch (e) {
      this.status.asr = { ...this.status.asr, state: 'error', error: String(e) };
      return;
    }
    this.asr = asr;
    this.status.asr.state = 'warming';
    // Through the queue, so a request arriving now waits for the warm model instead of running cold beside it.
    await this.serial(() => this.warmAsr(asr)).catch((e: unknown) => {
      this.asrFailures += 1;
      this.status.asr.error = `warm-up failed: ${String(e)}`;
    });
    this.status.asr.state = 'ready';
  }

  /**
   * Warm both models again (for example right before a live demo, after the
   * laptop slept). Returns how long each took. Waits behind running requests.
   */
  async warmup(): Promise<{ asrMs?: number; embedMs?: number }> {
    const out: { asrMs?: number; embedMs?: number } = {};
    if (this.needs) out.embedMs = await this.warmEmbed();
    const asr = this.asr;
    if (asr) out.asrMs = await this.serial(() => this.warmAsr(asr));
    return out;
  }

  /** Practice run on the speech model; records how long it took. */
  private async warmAsr(asr: Transcriber): Promise<number> {
    const t0 = Date.now();
    await withTimeout(asr.transcribe(warmupClip(), 'en', { maxNewTokens: 8 }), 90_000);
    const ms = Date.now() - t0;
    this.status.asr.warmupMs = ms;
    return ms;
  }

  /** One match per language and one crew reply, through the normal queue. */
  private async warmEmbed(): Promise<number> {
    const needs = this.needs;
    const replies = this.replies;
    const t0 = Date.now();
    for (const text of Object.values(WARMUP_PHRASES)) if (needs) await this.serial(() => needs.match(text));
    if (replies) await this.serial(() => replies.match('すぐにお持ちします'));
    const ms = Date.now() - t0;
    this.status.embed.warmupMs = ms;
    return ms;
  }

  /** Jobs waiting for (or running on) the models right now. */
  get queueLength(): number {
    return this.pending;
  }

  /** What a recording typically takes in Whisper here: recent median, else the warm-up run, else a guess. */
  estimateAsrMs(): number {
    const typical = median(this.asrTimes);
    if (typical) return typical;
    // The warm-up decodes only 8 tokens; a real request decodes more.
    if (this.status.asr.warmupMs) return Math.round(this.status.asr.warmupMs * 1.4);
    return this.options.asrSize === 'base' ? 1200 : 3000;
  }

  private record(list: number[], ms: number, key: 'asr' | 'embed'): void {
    list.push(ms);
    if (list.length > 15) list.shift();
    this.status[key].typicalMs = median(list);
  }

  get canTranscribe(): boolean {
    return this.asr !== null;
  }

  get asrSize(): AsrSize {
    return this.options.asrSize;
  }

  /** Language packs in use (data/languages/*.json). */
  languagePacks(): LanguagePack[] {
    return this.packs;
  }

  /** Re-read the language packs and the trained classifier without restarting (after npm run add-language). */
  async reloadLanguages(): Promise<void> {
    const packs = loadLanguagePacks();
    const needs = withLanguagePacks(undefined, packs);
    if (this.embedder) this.needs = await SemanticNeedMatcher.create(this.embedder, needs, loadNeedHead());
    this.keyword = createKeywordMatcher(needs);
    this.packs = packs;
  }

  /**
   * Speech → text. Throws if the speech model is not available. After two
   * failures in a row the model is reloaded in the background; meanwhile
   * passengers can still tap and type. `lang`: one of the 6 languages or a
   * language pack's code.
   */
  async transcribe(samples: Float32Array, lang: string, hooks: TranscribeHooks = {}): Promise<string> {
    const asr = this.asr;
    if (!asr) throw new Error('speech model not loaded');
    const voiced = trimSilence(samples);
    if (!voiced) return '';
    if (this.pending > 0) hooks.onQueued?.(this.pending);
    try {
      const pack = this.packs.find((p) => p.code === lang);
      const text = await this.serial(async () => {
        hooks.onStart?.(this.estimateAsrMs());
        const t0 = Date.now();
        const out = await withTimeout((this.asr ?? asr).transcribe(voiced, pack?.whisper ?? lang), 30_000);
        this.record(this.asrTimes, Date.now() - t0, 'asr');
        return out;
      });
      this.asrFailures = 0;
      return fromDevanagari(text, pack?.script);
    } catch (e) {
      if (++this.asrFailures >= 2) void this.loadAsr(this.options.asrSize);
      throw e;
    }
  }

  /**
   * Switch the speech model (small: more accurate, base: about 4× faster)
   * without restarting. The current model keeps working until the new one is
   * ready, and stays if the new one cannot load.
   */
  async switchAsr(size: AsrSize): Promise<void> {
    if (size === this.options.asrSize && this.asr) return;
    await this.loadAsr(size);
  }

  private async loadAsr(size: AsrSize): Promise<void> {
    this.asrFailures = 0;
    const previous = this.asr;
    const previousSize = this.options.asrSize;
    this.status.asr = { model: ASR_MODELS[size], state: 'loading' };
    try {
      const load = this.options.loadAsr && size === previousSize ? this.options.loadAsr : () => createWhisper(size, this.options.threads);
      const next = await load();
      // Warm the new model before it takes over; the previous one keeps serving meanwhile.
      this.status.asr = { model: ASR_MODELS[size], state: 'warming' };
      const warmupMs = await this.warmAsr(next).catch(() => undefined);
      this.asr = next;
      this.options.asrSize = size;
      if (size !== previousSize) this.asrTimes = [];
      this.status.asr = { model: ASR_MODELS[size], state: 'ready', warmupMs, typicalMs: median(this.asrTimes) };
      if (previous && previous !== next) await previous.dispose?.().catch(() => undefined);
    } catch (e) {
      this.status.asr = previous
        ? { model: ASR_MODELS[previousSize], state: 'ready', error: `could not load ${ASR_MODELS[size]}: ${String(e)}` }
        : { model: ASR_MODELS[size], state: 'error', error: String(e) };
    }
  }

  /** Text → need. Uses meaning-based matching when the embedding model is ready, else (or if it fails) keywords. */
  matchNeeds(text: string): Promise<MatchResult> {
    const needs = this.needs;
    if (!needs) return Promise.resolve(this.keyword.match(text));
    return this.serial(async () => {
      const t0 = Date.now();
      const m = await withTimeout(needs.match(text), 10_000);
      this.record(this.matchTimes, Date.now() - t0, 'embed');
      return m;
    }).catch(() => this.keyword.match(text));
  }

  /** A sentence with several requests or a refusal, each part matched on its own; undefined for a single request. */
  async understandMany(text: string): Promise<UnderstoodRequests | undefined> {
    if (!mayHoldSeveral(text)) return undefined;
    return understandRequests(text, (part) => this.matchNeeds(part), this.keyword);
  }

  /**
   * The crew member's own words in the passenger's language (NLLB-200, offline).
   * Loaded on first use, so a hub that never needs it never pays its memory.
   */
  async translate(text: string, from: string, to: string): Promise<string> {
    if (from === to) return text;
    const translator = await this.loadTranslator();
    return this.serial(() => withTimeout(translator.translate(text, from, to), 30_000));
  }

  /** Start loading the translation model (~15 s the first time), e.g. when a crew member opens "own words". */
  warmTranslator(): void {
    this.loadTranslator().catch(() => undefined);
  }

  private loadTranslator(): Promise<Translator> {
    this.translator ??= (this.options.loadTranslator ?? (() => createNllb(this.options.threads)))().catch((e: unknown) => {
      this.translator = null;
      throw e;
    });
    return this.translator;
  }

  /** Crew speech → closest verified reply (null when unsure or unavailable). */
  async matchReply(text: string): Promise<{ replyId: ReplyId | null; confidence: number }> {
    const replies = this.replies;
    if (!replies || !text.trim()) return { replyId: null, confidence: 0 };
    const r = await this.serial(() => replies.match(text));
    return { replyId: r.replyId, confidence: r.confidence };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.queue.then(run, run).finally(() => {
      this.pending -= 1;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
