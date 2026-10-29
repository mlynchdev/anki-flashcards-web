// FSRS-6 parameter optimizer: fits the 21 weights to a review history by minimising the log loss of
// the recall predictions. Adam on finite-difference gradients, like Anki's "Optimize" button in spirit.

import {
  DEFAULT_W,
  W_BOUNDS,
  decayFactor,
  initDifficulty,
  initStability,
  nextForgetStability,
  nextRecallStability,
  nextShortTermStability,
  normalizeWeights,
} from './fsrs';
import { dayOf } from './time';
import type { Revlog } from './types';

export interface ReviewItem {
  /** Whole days since the previous review of the card (0 for the first review and same-day repeats). */
  deltaT: number;
  /** 1-4. */
  rating: number;
}

export interface ReviewSequence {
  cardId: number;
  items: ReviewItem[];
}

export interface EvaluateResult {
  logLoss: number;
  rmse: number;
  count: number;
}

export interface OptimizeOptions {
  initial?: number[];
  iterations?: number;
  onProgress?: (fraction: number, loss: number) => void;
  shouldStop?: () => boolean;
}

export interface OptimizeResult {
  w: number[];
  before: number;
  after: number;
  reviews: number;
}

export const MIN_REVIEWS = 50;
const BATCH_REVIEWS = 4000;
const DEFAULT_ITERATIONS = 150;
const BASE_LR = 0.04;
const P_EPS = 1e-6;
const BINS = 20;

export function buildTrainingSet(revlog: Revlog[], rolloverHour: number): ReviewSequence[] {
  const byCard = new Map<number, Revlog[]>();
  for (const r of revlog) {
    let list = byCard.get(r.cardId);
    if (!list) byCard.set(r.cardId, (list = []));
    list.push(r);
  }

  const out: ReviewSequence[] = [];
  for (const [cardId, entries] of byCard) {
    entries.sort((a, b) => a.id - b.id);

    // A manual "forget" (ease 0, ivl 0) resets the card: only history after the last one counts.
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].ease === 0 && entries[i].ivl === 0) {
        start = i + 1;
        break;
      }
    }
    const kept = entries.slice(start).filter((r) => r.ease !== 0 && r.type !== 4);
    // Without the first learning review the initial memory state is unknown.
    if (kept.length < 2 || kept[0].type !== 0) continue;

    const items: ReviewItem[] = [];
    let prevDay = 0;
    let useful = false;
    for (let i = 0; i < kept.length; i++) {
      const day = dayOf(kept[i].id, rolloverHour);
      const deltaT = i === 0 ? 0 : Math.max(0, day - prevDay);
      if (deltaT >= 1) useful = true;
      items.push({ deltaT, rating: kept[i].ease });
      prevDay = day;
    }
    // Sequences with no review after a day or more never contribute to the loss.
    if (useful) out.push({ cardId, items });
  }
  return out;
}

/** Count of reviews that contribute to the loss. */
function lossCount(data: ReviewSequence[]): number {
  let n = 0;
  for (const seq of data) for (let i = 1; i < seq.items.length; i++) if (seq.items[i].deltaT >= 1) n++;
  return n;
}

function totalItems(data: ReviewSequence[]): number {
  let n = 0;
  for (const seq of data) n += seq.items.length;
  return n;
}

/**
 * Replays one sequence, calling `visit(p, recalled)` for each loss-contributing review. Mirrors
 * `nextMemoryState` in fsrs.ts but without allocating or recomputing the decay constants per
 * review, since the optimizer runs this tens of millions of times.
 */
function replay(
  w: readonly number[],
  decay: number,
  factor: number,
  items: ReviewItem[],
  visit: (p: number, recalled: boolean) => void,
): void {
  const hardD = initDifficulty(w, 4);
  const meanRevert = w[7];
  let s = 0;
  let d = 0;
  for (let i = 0; i < items.length; i++) {
    const { deltaT, rating: g } = items[i];
    if (i === 0) {
      s = initStability(w, g);
      d = Math.min(Math.max(initDifficulty(w, g), 1), 10);
      continue;
    }
    if (deltaT === 0) {
      s = nextShortTermStability(w, s, g);
    } else {
      const r = Math.pow(1 + (factor * deltaT) / s, decay);
      visit(clampP(r), g > 1);
      s = g === 1 ? nextForgetStability(w, d, s, r) : nextRecallStability(w, d, s, r, g);
    }
    // nextDifficulty, with the constant initDifficulty(w, 4) hoisted.
    const next = d + (-w[6] * (g - 3) * (10 - d)) / 9;
    d = Math.min(Math.max(meanRevert * hardD + (1 - meanRevert) * next, 1), 10);
  }
}

/** Sum of binary cross-entropy over loss-contributing reviews. */
function lossSum(w: readonly number[], data: ReviewSequence[]): { sum: number; n: number } {
  const { decay, factor } = decayFactor(w);
  let sum = 0;
  let n = 0;
  const visit = (p: number, recalled: boolean) => {
    sum -= recalled ? Math.log(p) : Math.log(1 - p);
    n++;
  };
  for (const seq of data) replay(w, decay, factor, seq.items, visit);
  return { sum, n };
}

function clampP(p: number): number {
  if (!(p > P_EPS)) return P_EPS; // also catches NaN
  return p > 1 - P_EPS ? 1 - P_EPS : p;
}

export function evaluate(w: number[], data: ReviewSequence[]): EvaluateResult {
  const binCount = new Array<number>(BINS).fill(0);
  const binPred = new Array<number>(BINS).fill(0);
  const binActual = new Array<number>(BINS).fill(0);
  const { decay, factor } = decayFactor(w);
  let sum = 0;
  let n = 0;
  const visit = (p: number, recalled: boolean) => {
    sum -= recalled ? Math.log(p) : Math.log(1 - p);
    n++;
    const b = Math.min(BINS - 1, Math.floor(p * BINS));
    binCount[b]++;
    binPred[b] += p;
    if (recalled) binActual[b]++;
  };
  for (const seq of data) replay(w, decay, factor, seq.items, visit);
  if (n === 0) return { logLoss: 0, rmse: 0, count: 0 };
  let sq = 0;
  for (let b = 0; b < BINS; b++) {
    if (binCount[b] === 0) continue;
    const diff = (binPred[b] - binActual[b]) / binCount[b];
    sq += binCount[b] * diff * diff;
  }
  return { logLoss: sum / n, rmse: Math.sqrt(sq / n), count: n };
}

/** Small deterministic PRNG (mulberry32) so optimisation runs are reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampW = (v: number, i: number) => Math.min(Math.max(v, W_BOUNDS[i][0]), W_BOUNDS[i][1]);

// Length scale per weight for the pull toward the defaults: narrow for the small-range parameters,
// capped for the wide stability ones.
const PRIOR_SCALE = W_BOUNDS.map(([lo, hi]) => Math.min(hi - lo, 10) / 2);

function penalty(w: readonly number[], coeff: number): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) {
    const z = (w[i] - DEFAULT_W[i]) / PRIOR_SCALE[i];
    s += z * z;
  }
  return 0.5 * coeff * s;
}

function round4(w: number[]): number[] {
  return w.map((v, i) => clampW(Math.round(v * 1e4) / 1e4, i));
}

export function optimize(data: ReviewSequence[], opts: OptimizeOptions = {}): OptimizeResult {
  const reviews = lossCount(data);
  if (reviews < MIN_REVIEWS) {
    throw new Error(
      `Not enough review history to optimize: need at least ${MIN_REVIEWS} reviews older than a day (found ${reviews}).`,
    );
  }

  const iterations = Math.max(1, opts.iterations ?? DEFAULT_ITERATIONS);
  const start = normalizeWeights(opts.initial ?? DEFAULT_W);
  const coeff = 1 / Math.sqrt(reviews);
  const objective = (w: readonly number[], d: ReviewSequence[]) => {
    const { sum, n } = lossSum(w, d);
    const v = n > 0 ? sum / n + penalty(w, coeff) : Infinity;
    return Number.isFinite(v) ? v : Infinity;
  };

  const startRounded = round4(start);
  const before = evaluate(startRounded, data).logLoss;
  const startObjective = objective(start, data);

  // Mini-batches of whole sequences, drawn from a shuffled order, so each step stays cheap.
  const rng = makeRng(12345);
  const total = totalItems(data);
  const useBatches = total > BATCH_REVIEWS * 1.25;
  const order = data.map((_, i) => i);
  let cursor = order.length;
  const nextBatch = (): ReviewSequence[] => {
    if (!useBatches) return data;
    const batch: ReviewSequence[] = [];
    let items = 0;
    while (items < BATCH_REVIEWS) {
      if (cursor >= order.length) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        cursor = 0;
      }
      const seq = data[order[cursor++]];
      batch.push(seq);
      items += seq.items.length;
    }
    return batch;
  };

  const n = start.length;
  const w = [...start];
  const m = new Array<number>(n).fill(0);
  const v = new Array<number>(n).fill(0);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const adamEps = 1e-8;

  let best = [...start];
  let bestObjective = startObjective;
  const evalEvery = 5;

  for (let t = 1; t <= iterations; t++) {
    if (opts.shouldStop?.()) break;
    const batch = nextBatch();
    const lr = BASE_LR * (0.1 + 0.9 * 0.5 * (1 + Math.cos((Math.PI * (t - 1)) / iterations)));

    for (let i = 0; i < n; i++) {
      const [lo, hi] = W_BOUNDS[i];
      const h = 1e-4 * Math.max(Math.abs(w[i]), 0.1);
      const hiW = Math.min(w[i] + h, hi);
      const loW = Math.max(w[i] - h, lo);
      if (hiW <= loW) continue;
      const orig = w[i];
      w[i] = hiW;
      const fp = objective(w, batch);
      w[i] = loW;
      const fm = objective(w, batch);
      w[i] = orig;
      let g = (fp - fm) / (hiW - loW);
      if (!Number.isFinite(g)) g = 0;
      m[i] = beta1 * m[i] + (1 - beta1) * g;
      v[i] = beta2 * v[i] + (1 - beta2) * g * g;
    }
    const c1 = 1 - Math.pow(beta1, t);
    const c2 = 1 - Math.pow(beta2, t);
    for (let i = 0; i < n; i++) {
      w[i] = clampW(w[i] - (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + adamEps), i);
    }

    const last = t === iterations;
    if (t % evalEvery === 0 || last) {
      const f = objective(w, data);
      if (f < bestObjective) {
        bestObjective = f;
        best = [...w];
      }
      opts.onProgress?.(t / iterations, Number.isFinite(f) ? f : bestObjective);
    } else {
      opts.onProgress?.(t / iterations, bestObjective);
    }
  }

  // Make sure a stop request or the final iteration still gets its weights compared.
  const finalObjective = objective(w, data);
  if (finalObjective < bestObjective) {
    bestObjective = finalObjective;
    best = [...w];
  }

  let result = round4(best);
  let after = evaluate(result, data).logLoss;
  // Rounding or the prior must never leave us worse than where we started.
  if (!(after <= before)) {
    result = startRounded;
    after = before;
  }
  opts.onProgress?.(1, after);
  return { w: result, before, after, reviews };
}
