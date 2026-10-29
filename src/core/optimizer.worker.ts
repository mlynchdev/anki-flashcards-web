// Module Web Worker: runs the FSRS optimizer off the main thread.
import { buildTrainingSet, optimize } from './optimizer';
import type { Revlog } from './types';

export interface OptimizerRequest {
  revlog: Revlog[];
  rolloverHour: number;
  initial?: number[];
}

export type OptimizerMessage =
  | { type: 'progress'; fraction: number; loss: number }
  | { type: 'done'; w: number[]; before: number; after: number; reviews: number }
  | { type: 'error'; message: string };

const post = (msg: OptimizerMessage) => (self as unknown as Worker).postMessage(msg);

self.addEventListener('message', (e: MessageEvent<OptimizerRequest>) => {
  try {
    const { revlog, rolloverHour, initial } = e.data;
    const data = buildTrainingSet(revlog, rolloverHour);
    let lastPost = 0;
    const result = optimize(data, {
      initial,
      onProgress: (fraction, loss) => {
        const now = Date.now();
        if (now - lastPost < 50 && fraction < 1) return;
        lastPost = now;
        post({ type: 'progress', fraction, loss });
      },
    });
    post({ type: 'done', ...result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});
