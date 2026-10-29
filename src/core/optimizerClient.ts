import type { OptimizerMessage, OptimizerRequest } from './optimizer.worker';
import type { Revlog } from './types';

export interface OptimizerOutput {
  w: number[];
  before: number;
  after: number;
  reviews: number;
}

/** Fits FSRS-6 weights to the review history in a Web Worker. Rejects with a friendly message on failure. */
export function runOptimizer(
  revlog: Revlog[],
  rolloverHour: number,
  initial: number[] | undefined,
  onProgress?: (fraction: number, loss: number) => void,
): Promise<OptimizerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<OptimizerMessage>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.fraction, msg.loss);
      } else if (msg.type === 'done') {
        finish();
        resolve({ w: msg.w, before: msg.before, after: msg.after, reviews: msg.reviews });
      } else {
        finish();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'The optimizer failed unexpectedly.'));
    };
    const request: OptimizerRequest = { revlog, rolloverHour, initial };
    worker.postMessage(request);
  });
}
