import { describe, expect, it } from 'vitest';
import { DEFAULT_W, W_BOUNDS, intervalFor, nextMemoryState, retrievability } from '../src/core/fsrs';
import type { MemoryState } from '../src/core/fsrs';
import { buildTrainingSet, evaluate, optimize } from '../src/core/optimizer';
import type { Revlog } from '../src/core/types';

const ROLLOVER = 4;
// Local noon of a day, so day arithmetic is independent of timezone and DST.
const noon = (day: number) => new Date(2024, 0, 1 + day, 12, 0, 0).getTime();

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function row(id: number, cardId: number, ease: 0 | 1 | 2 | 3 | 4, type: 0 | 1 | 2 | 3 | 4, ivl = 1): Revlog {
  return { id, cardId, ease, ivl, lastIvl: 0, factor: 0, time: 0, type };
}

const TRUE_W = DEFAULT_W.map((x, i) => {
  if (i < 4) return x * [1.6, 1.4, 1.2, 0.8][i];
  if (i === 20) return 0.3;
  if (i === 8) return 1.5;
  return x;
});

/** Simulates cards reviewed with intervals chosen from the true model's stability. */
function simulate(cards: number, reviewsPerCard: number, seed: number): Revlog[] {
  const rand = rng(seed);
  const out: Revlog[] = [];
  let seq = 0;
  for (let c = 1; c <= cards; c++) {
    let day = Math.floor(rand() * 30);
    let g = rand() < 0.15 ? 1 : rand() < 0.2 ? 2 : rand() < 0.8 ? 3 : 4;
    let state: MemoryState = nextMemoryState(TRUE_W, null, 0, g);
    out.push(row(noon(day) + seq++, c, g as 1, 0));
    // Occasional same-day relearn repeat after a lapse in the first session.
    if (g === 1) {
      g = 3;
      state = nextMemoryState(TRUE_W, state, 0, g);
      out.push(row(noon(day) + 3_600_000 + seq++, c, 3, 0));
    }
    for (let r = 0; r < reviewsPerCard; r++) {
      const target = intervalFor(TRUE_W, state.stability, 0.6 + rand() * 0.35);
      const dt = Math.max(1, Math.round(target));
      day += dt;
      const p = retrievability(TRUE_W, dt, state.stability);
      if (rand() < p) {
        const u = rand();
        g = u < 0.1 ? 2 : u < 0.85 ? 3 : 4;
      } else {
        g = 1;
      }
      state = nextMemoryState(TRUE_W, state, dt, g);
      out.push(row(noon(day) + seq++, c, g as 1, g === 1 ? 2 : 1, dt));
    }
  }
  return out;
}

describe('buildTrainingSet', () => {
  it('keeps same-day reviews, drops manual entries, and computes whole-day gaps', () => {
    const rows: Revlog[] = [
      row(noon(0), 1, 3, 0),
      row(noon(0) + 3_600_000, 1, 3, 0), // same day
      row(noon(0) + 5_000, 1, 0, 4), // manual set-due: ignored
      row(noon(3), 1, 4, 1),
      row(noon(10), 1, 1, 1),
    ];
    const [seq] = buildTrainingSet(rows, ROLLOVER);
    expect(seq.items).toEqual([
      { deltaT: 0, rating: 3 },
      { deltaT: 0, rating: 3 },
      { deltaT: 3, rating: 4 },
      { deltaT: 7, rating: 1 },
    ]);
  });

  it('honours the rollover hour when counting days', () => {
    const late = new Date(2024, 0, 1, 23, 0).getTime();
    const early = new Date(2024, 0, 2, 2, 0).getTime(); // before 4am: still "day 1"
    const next = new Date(2024, 0, 2, 5, 0).getTime();
    const [seq] = buildTrainingSet([row(late, 1, 3, 0), row(early, 1, 3, 1), row(next, 1, 3, 1)], ROLLOVER);
    expect(seq.items.map((i) => i.deltaT)).toEqual([0, 0, 1]);
  });

  it('only uses history after the last forget, and drops cards that do not start with a learn entry', () => {
    const rows: Revlog[] = [
      // card 1: reviewed, forgotten, then relearned from scratch
      row(noon(0), 1, 3, 0),
      row(noon(2), 1, 3, 1),
      row(noon(5), 1, 0, 4, 0), // forget
      row(noon(6), 1, 2, 0),
      row(noon(9), 1, 3, 1),
      // card 2: first remaining entry is a review (history imported without its learn entry)
      row(noon(0), 2, 3, 1),
      row(noon(4), 2, 3, 1),
      // card 3: single review, nothing to learn from
      row(noon(0), 3, 3, 0),
      // card 4: only same-day reviews never contribute
      row(noon(0), 4, 3, 0),
      row(noon(0) + 1000, 4, 3, 0),
    ];
    const sets = buildTrainingSet(rows, ROLLOVER);
    expect(sets.map((s) => s.cardId)).toEqual([1]);
    expect(sets[0].items).toEqual([
      { deltaT: 0, rating: 2 },
      { deltaT: 3, rating: 3 },
    ]);
  });
});

describe('evaluate / optimize', () => {
  const revlog = simulate(220, 12, 42);
  const data = buildTrainingSet(revlog, ROLLOVER);

  it('evaluate returns finite, sensible numbers', () => {
    const r = evaluate([...DEFAULT_W], data);
    expect(r.count).toBeGreaterThan(1500);
    expect(Number.isFinite(r.logLoss)).toBe(true);
    expect(r.logLoss).toBeGreaterThan(0);
    expect(Number.isFinite(r.rmse)).toBe(true);
    expect(r.rmse).toBeGreaterThanOrEqual(0);
    expect(r.rmse).toBeLessThan(1);
    // The generating weights should fit better than the defaults.
    expect(evaluate([...TRUE_W], data).logLoss).toBeLessThan(r.logLoss);
  });

  it('matches a reference replay built on nextMemoryState', () => {
    const w = [...TRUE_W];
    let sum = 0;
    let n = 0;
    for (const seq of data) {
      let state: MemoryState | null = null;
      for (const { deltaT, rating } of seq.items) {
        if (state && deltaT >= 1) {
          const p = retrievability(w, deltaT, state.stability);
          sum -= rating > 1 ? Math.log(p) : Math.log(1 - p);
          n++;
        }
        state = nextMemoryState(w, state, deltaT, rating);
      }
    }
    const got = evaluate(w, data);
    expect(got.count).toBe(n);
    expect(got.logLoss).toBeCloseTo(sum / n, 6);
  });

  it('refuses tiny histories with a friendly message', () => {
    const tiny = buildTrainingSet(simulate(3, 4, 7), ROLLOVER);
    expect(() => optimize(tiny)).toThrow(/Not enough review history to optimize/);
  });

  it('reduces the log loss versus the defaults and respects the bounds', () => {
    const progress: number[] = [];
    const t0 = Date.now();
    const res = optimize(data, { onProgress: (f) => progress.push(f) });
    const ms = Date.now() - t0;
    const defaults = evaluate([...DEFAULT_W], data).logLoss;
    console.log(
      `optimizer: reviews=${res.reviews} default=${defaults.toFixed(4)} before=${res.before.toFixed(4)} ` +
        `after=${res.after.toFixed(4)} true=${evaluate([...TRUE_W], data).logLoss.toFixed(4)} ${ms}ms`,
    );
    expect(res.w).toHaveLength(21);
    res.w.forEach((x, i) => {
      expect(x).toBeGreaterThanOrEqual(W_BOUNDS[i][0]);
      expect(x).toBeLessThanOrEqual(W_BOUNDS[i][1]);
      expect(Math.abs(x * 1e4 - Math.round(x * 1e4))).toBeLessThan(1e-6);
    });
    expect(res.before).toBeCloseTo(defaults, 3);
    expect(res.after).toBeLessThan(res.before - 0.002);
    expect(evaluate(res.w, data).logLoss).toBeCloseTo(res.after, 6);
    expect(progress.at(-1)).toBe(1);
    expect(ms).toBeLessThan(10_000);
  });

  it('stops early on request and still returns usable weights', () => {
    let calls = 0;
    const res = optimize(data, { iterations: 100, shouldStop: () => ++calls > 3 });
    expect(res.after).toBeLessThanOrEqual(res.before);
    expect(res.w).toHaveLength(21);
  });
});
