import { Worker } from 'node:worker_threads';
import type { WorkerJob, ExtractedPdf, RenderedPage } from './pdf-types.ts';

const WORKER_URL = new URL('./pdf-worker.ts', import.meta.url);

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run one job in a fresh worker thread. Cancelling is cooperative: terminating a thread in the middle of WASM
 * execution crashes V8, so the worker polls a shared flag between pages and exits by itself. Only a worker that
 * ignores the flag for 15 s is terminated.
 */
function runWorker<T>(job: WorkerJob, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(WORKER_URL, { workerData: { job, flag } });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      Atomics.store(flag, 0, 1);
      const kill = setTimeout(() => void worker.terminate(), 15_000);
      kill.unref();
      worker.once('exit', () => clearTimeout(kill));
      finish(() => reject(abortError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: Reply<T>) => finish(() => (msg.ok ? resolve(msg.value) : reject(new Error(msg.error)))));
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => finish(() => reject(new Error(`PDF worker exited with code ${code}`))));
  });
}

export function abortError(): Error {
  const e = new Error('Extraction was cancelled.');
  e.name = 'AbortError';
  return e;
}

export const extractPdfInWorker = (file: string, signal?: AbortSignal) => runWorker<ExtractedPdf>({ op: 'extract', file }, signal);

export const renderPdfInWorker = (file: string, idx: number, scale: number, highlight: string | undefined, signal?: AbortSignal) =>
  runWorker<RenderedPage>({ op: 'render', file, idx, scale, highlight }, signal);
