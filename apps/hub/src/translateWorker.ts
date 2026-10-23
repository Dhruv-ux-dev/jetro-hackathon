/**
 * Runs NLLB-200 off the hub's main thread: loading the model takes ~15 s and
 * each translation a few seconds of CPU, and the hub must keep answering
 * phones, crew tablets and the stage meanwhile.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createNllb } from './translate';

const port = parentPort!;
const ready = createNllb((workerData as { threads: number }).threads);
ready.then(
  () => port.postMessage({ kind: 'ready' }),
  (e: unknown) => port.postMessage({ kind: 'failed', error: e instanceof Error ? e.message : String(e) }),
);
port.on('message', async (m: { id: number; text: string; from: string; to: string }) => {
  try {
    const text = await (await ready).translate(m.text, m.from, m.to);
    port.postMessage({ kind: 'done', id: m.id, text });
  } catch (e) {
    port.postMessage({ kind: 'done', id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
