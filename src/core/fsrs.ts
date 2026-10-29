// FSRS-6 memory model, ported from ts-fsrs / fsrs-rs. Pure functions of the weight vector so the
// optimizer can evaluate arbitrary parameters.

export const DEFAULT_W: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

export const S_MIN = 0.001;
export const S_MAX = 36500;

/** Parameter bounds, as used by the FSRS optimizer. */
export const W_BOUNDS: readonly [number, number][] = [
  [S_MIN, 100],
  [S_MIN, 100],
  [S_MIN, 100],
  [S_MIN, 100],
  [1, 10],
  [0.001, 4],
  [0.001, 4],
  [0.001, 0.75],
  [0, 4.5],
  [0, 0.8],
  [0.001, 3.5],
  [0.001, 5],
  [0.001, 0.25],
  [0.001, 0.9],
  [0, 4],
  [0, 1],
  [1, 6],
  [0, 2],
  [0, 2],
  [0.01, 0.8],
  [0.1, 0.8],
];

export interface MemoryState {
  stability: number;
  difficulty: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Upgrades FSRS-4.5/5 parameter vectors (17/19 weights) to FSRS-6 (21). */
export function normalizeWeights(w: readonly number[] | undefined): number[] {
  if (!w || w.length === 0) return [...DEFAULT_W];
  let out = [...w];
  if (out.length === 17) out = [...out, 0, 0];
  if (out.length === 19) out = [...out, 0, 0.5];
  if (out.length !== 21 || out.some((x) => !Number.isFinite(x))) return [...DEFAULT_W];
  return out.map((x, i) => clamp(x, W_BOUNDS[i][0], W_BOUNDS[i][1]));
}

export function decayFactor(w: readonly number[]) {
  const decay = -w[20];
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return { decay, factor };
}

export function retrievability(w: readonly number[], elapsedDays: number, stability: number): number {
  const { decay, factor } = decayFactor(w);
  return Math.pow(1 + (factor * Math.max(0, elapsedDays)) / stability, decay);
}

/** Interval (days, unrounded) at which retrievability falls to `retention`. */
export function intervalFor(w: readonly number[], stability: number, retention: number): number {
  const { decay, factor } = decayFactor(w);
  return (stability / factor) * (Math.pow(retention, 1 / decay) - 1);
}

export function initStability(w: readonly number[], g: number): number {
  return Math.max(w[g - 1], 0.1);
}

export function initDifficulty(w: readonly number[], g: number): number {
  return w[4] - Math.exp((g - 1) * w[5]) + 1;
}

export function nextDifficulty(w: readonly number[], d: number, g: number): number {
  const delta = -w[6] * (g - 3);
  const next = d + (delta * (10 - d)) / 9;
  const reverted = w[7] * initDifficulty(w, 4) + (1 - w[7]) * next;
  return clamp(reverted, 1, 10);
}

export function nextRecallStability(w: readonly number[], d: number, s: number, r: number, g: number): number {
  const hardPenalty = g === 2 ? w[15] : 1;
  const easyBonus = g === 4 ? w[16] : 1;
  return clamp(
    s *
      (1 +
        Math.exp(w[8]) *
          (11 - d) *
          Math.pow(s, -w[9]) *
          (Math.exp((1 - r) * w[10]) - 1) *
          hardPenalty *
          easyBonus),
    S_MIN,
    S_MAX,
  );
}

export function nextForgetStability(w: readonly number[], d: number, s: number, r: number): number {
  const forget = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
  const floor = s / Math.exp(w[17] * w[18]);
  return clamp(Math.min(forget, floor), S_MIN, S_MAX);
}

export function nextShortTermStability(w: readonly number[], s: number, g: number): number {
  let sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
  if (g >= 2) sinc = Math.max(sinc, 1);
  return clamp(s * sinc, S_MIN, S_MAX);
}

/**
 * Memory state after rating `g` given the previous state (null for a first review) and the
 * whole days elapsed since the previous review.
 */
export function nextMemoryState(
  w: readonly number[],
  prev: MemoryState | null,
  elapsedDays: number,
  g: number,
): MemoryState {
  if (!prev) {
    return { stability: initStability(w, g), difficulty: clamp(initDifficulty(w, g), 1, 10) };
  }
  const { stability: s, difficulty: d } = prev;
  let ns: number;
  if (elapsedDays === 0) {
    ns = nextShortTermStability(w, s, g);
  } else {
    const r = retrievability(w, elapsedDays, s);
    ns = g === 1 ? nextForgetStability(w, d, s, r) : nextRecallStability(w, d, s, r, g);
  }
  return { stability: ns, difficulty: nextDifficulty(w, d, g) };
}

/**
 * Approximate memory state for a card scheduled by SM-2 (no FSRS history), as Anki does when
 * FSRS is first enabled: stability from the interval, difficulty from the ease factor.
 */
export function memoryFromSm2(w: readonly number[], ivl: number, ease: number, retention: number): MemoryState {
  // Solve intervalFor(S) = ivl  ->  S = ivl * factor / (r^(1/decay) - 1)
  const { decay, factor } = decayFactor(w);
  const s = clamp((Math.max(ivl, 1) * factor) / (Math.pow(retention, 1 / decay) - 1), S_MIN, S_MAX);
  const d = clamp(11 - ((ease || 2.5) - 1) / 0.2 + 1, 1, 10);
  return { stability: s, difficulty: d };
}
