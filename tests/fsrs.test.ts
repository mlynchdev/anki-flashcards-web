import { describe, expect, it } from 'vitest';
import { FSRSAlgorithm, generatorParameters, default_w, forgetting_curve } from 'ts-fsrs';
import {
  DEFAULT_W,
  initDifficulty,
  initStability,
  intervalFor,
  nextDifficulty,
  nextForgetStability,
  nextMemoryState,
  nextRecallStability,
  nextShortTermStability,
  retrievability,
} from '../src/core/fsrs';

const ref = new FSRSAlgorithm(generatorParameters({ enable_fuzz: false, enable_short_term: true }));

describe('FSRS-6 port matches ts-fsrs', () => {
  it('uses the same default weights', () => {
    expect([...DEFAULT_W]).toEqual([...default_w]);
  });

  it('initial stability and difficulty', () => {
    for (const g of [1, 2, 3, 4] as const) {
      expect(initStability(DEFAULT_W, g)).toBeCloseTo(ref.init_stability(g), 6);
      expect(initDifficulty(DEFAULT_W, g)).toBeCloseTo(ref.init_difficulty(g), 6);
    }
  });

  it('forgetting curve and intervals', () => {
    for (const [t, s] of [
      [1, 1],
      [10, 3.2],
      [100, 40],
    ]) {
      expect(retrievability(DEFAULT_W, t, s)).toBeCloseTo(forgetting_curve(default_w, t, s), 6);
    }
    // At desired retention 0.9 the interval equals the stability.
    expect(intervalFor(DEFAULT_W, 12.5, 0.9)).toBeCloseTo(12.5, 6);
    expect(intervalFor(DEFAULT_W, 10, 0.8)).toBeGreaterThan(10);
  });

  it('stability and difficulty updates', () => {
    for (const [d, s, r] of [
      [5, 3, 0.9],
      [2, 20, 0.7],
      [9, 1.2, 0.95],
    ]) {
      for (const g of [2, 3, 4] as const) {
        expect(nextRecallStability(DEFAULT_W, d, s, r, g)).toBeCloseTo(ref.next_recall_stability(d, s, r, g), 5);
        expect(nextDifficulty(DEFAULT_W, d, g)).toBeCloseTo(ref.next_difficulty(d, g), 5);
        expect(nextShortTermStability(DEFAULT_W, s, g)).toBeCloseTo(ref.next_short_term_stability(s, g), 5);
      }
      const floor = s / Math.exp(DEFAULT_W[17] * DEFAULT_W[18]);
      expect(nextForgetStability(DEFAULT_W, d, s, r)).toBeCloseTo(
        Math.min(ref.next_forget_stability(d, s, r), floor),
        5,
      );
    }
  });

  it('next_state agrees for a review sequence', () => {
    const seq: [number, 1 | 2 | 3 | 4][] = [
      [0, 3],
      [0, 3],
      [1, 3],
      [3, 2],
      [8, 1],
      [0, 3],
      [2, 4],
    ];
    let ours = null as ReturnType<typeof nextMemoryState> | null;
    let theirs = null as { stability: number; difficulty: number } | null;
    for (const [t, g] of seq) {
      ours = nextMemoryState(DEFAULT_W, ours, t, g);
      theirs = ref.next_state(theirs, t, g);
      expect(ours.stability).toBeCloseTo(theirs.stability, 4);
      expect(ours.difficulty).toBeCloseTo(theirs.difficulty, 4);
    }
  });
});
