import { describe, expect, it } from 'vitest';
import { type Card, CardState, type DeckConfig } from '../src/core/types';
import {
  DEFAULT_CONFIG,
  constrainedIvl,
  fuzzRange,
  isLeech,
  nextStates,
  type SchedContext,
  stepOutcome,
} from '../src/core/scheduler';
import { dayOf, dayStart } from '../src/core/time';

const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime();
const ROLL = 4;
const TODAY = dayOf(NOW, ROLL);

function conf(patch: Partial<DeckConfig> = {}): DeckConfig {
  return { ...DEFAULT_CONFIG, id: 1, name: 'Default', mod: 0, ...patch };
}

function ctx(patch: Partial<SchedContext> = {}): SchedContext {
  return { now: NOW, today: TODAY, rolloverHour: ROLL, conf: conf(), scheduler: 'sm2', fuzz: false, ...patch };
}

function newCard(patch: Partial<Card> = {}): Card {
  return {
    id: 1_700_000_000_000,
    noteId: 1,
    deckId: 1,
    ord: 0,
    state: CardState.New,
    due: 1,
    ivl: 0,
    ease: 0,
    reps: 0,
    lapses: 0,
    step: 0,
    suspended: false,
    buried: 0,
    flag: 0,
    mod: 0,
    ...patch,
  };
}

function reviewCard(ivl: number, ease = 2.5, daysSinceReview = ivl, patch: Partial<Card> = {}): Card {
  return newCard({
    state: CardState.Review,
    ivl,
    ease,
    reps: 5,
    due: TODAY - daysSinceReview + ivl,
    lastReview: dayStart(TODAY - daysSinceReview, ROLL) + 3_600_000,
    ...patch,
  });
}

describe('day numbers', () => {
  it('respects the rollover hour', () => {
    const before = new Date(2026, 9, 29, 3, 59).getTime();
    const after = new Date(2026, 9, 29, 4, 0).getTime();
    expect(dayOf(after, 4) - dayOf(before, 4)).toBe(1);
    expect(dayStart(dayOf(after, 4), 4)).toBe(after);
  });
});

describe('learning steps', () => {
  const steps = [1, 10];
  it('again goes back to the first step', () => {
    expect(stepOutcome(steps, 1, 1)).toEqual({ kind: 'step', step: 0, mins: 1 });
  });
  it('hard on the first step averages the first two steps', () => {
    expect(stepOutcome(steps, 0, 2)).toEqual({ kind: 'step', step: 0, mins: 5.5 });
  });
  it('hard with a single step is 1.5x, capped at one day more', () => {
    expect(stepOutcome([10], 0, 2)).toEqual({ kind: 'step', step: 0, mins: 15 });
    expect(stepOutcome([2880], 0, 2)).toEqual({ kind: 'step', step: 0, mins: 4320 });
  });
  it('hard on a later step repeats it', () => {
    expect(stepOutcome([1, 10, 60], 2, 2)).toEqual({ kind: 'step', step: 2, mins: 60 });
  });
  it('good advances, then graduates', () => {
    expect(stepOutcome(steps, 0, 3)).toEqual({ kind: 'step', step: 1, mins: 10 });
    expect(stepOutcome(steps, 1, 3)).toEqual({ kind: 'graduate', easy: false });
  });
  it('easy graduates immediately', () => {
    expect(stepOutcome(steps, 0, 4)).toEqual({ kind: 'graduate', easy: true });
  });
});

describe('SM-2', () => {
  it('new card: steps then graduating/easy intervals', () => {
    const s = nextStates(newCard(), ctx());
    expect(s[1].card.state).toBe(CardState.Learning);
    expect(s[1].secs).toBe(60);
    expect(s[1].card.due).toBe(NOW + 60_000);
    expect(s[2].secs).toBe(330);
    expect(s[3].secs).toBe(600);
    expect(s[3].card.step).toBe(1);
    expect(s[4].card.state).toBe(CardState.Review);
    expect(s[4].card.ivl).toBe(4);
    expect(s[4].card.due).toBe(TODAY + 4);
    expect(s[4].card.ease).toBe(2.5);
  });

  it('graduating from the last learning step', () => {
    const card = newCard({ state: CardState.Learning, step: 1, reps: 1, due: NOW, lastReview: NOW - 600_000 });
    const s = nextStates(card, ctx());
    expect(s[3].card.state).toBe(CardState.Review);
    expect(s[3].card.ivl).toBe(1);
    expect(s[3].card.due).toBe(TODAY + 1);
  });

  it('interday learning steps are due at the start of a day', () => {
    const s = nextStates(newCard(), ctx({ conf: conf({ learnSteps: [1440, 4320] }) }));
    expect(s[1].card.due).toBe(dayStart(TODAY + 1, ROLL));
    expect(s[3].card.due).toBe(dayStart(TODAY + 3, ROLL));
  });

  it('review intervals follow Anki v3 formulas', () => {
    const s = nextStates(reviewCard(10, 2.5), ctx());
    expect(s[2].card.ivl).toBe(12); // 10 * 1.2
    expect(s[3].card.ivl).toBe(25); // 10 * 2.5
    expect(s[4].card.ivl).toBe(33); // 10 * 2.5 * 1.3 = 32.5 -> 33
    expect(s[2].card.ease).toBeCloseTo(2.35);
    expect(s[3].card.ease).toBeCloseTo(2.5);
    expect(s[4].card.ease).toBeCloseTo(2.65);
  });

  it('overdue days count half for good and fully for easy', () => {
    const s = nextStates(reviewCard(10, 2.5, 14), ctx());
    expect(s[3].card.ivl).toBe(30); // (10 + 4/2) * 2.5
    expect(s[4].card.ivl).toBe(46); // (10 + 4) * 2.5 * 1.3 = 45.5
  });

  it('hard >= ivl+1, good > hard, easy > good for tiny intervals', () => {
    const s = nextStates(reviewCard(1, 1.3), ctx());
    expect(s[2].card.ivl).toBe(2);
    expect(s[3].card.ivl).toBe(3);
    expect(s[4].card.ivl).toBe(4);
  });

  it('lapse: relearning, ease penalty, new interval', () => {
    const s = nextStates(reviewCard(20, 2.5), ctx({ conf: conf({ lapseMult: 0.5 }) }));
    const again = s[1].card;
    expect(again.state).toBe(CardState.Relearning);
    expect(again.lapses).toBe(1);
    expect(again.ease).toBeCloseTo(2.3);
    expect(again.ivl).toBe(10);
    expect(again.due).toBe(NOW + 10 * 60_000);
    // finishing relearning returns to review with the lapse interval
    const back = nextStates({ ...again }, ctx({ now: NOW + 600_000 }))[3].card;
    expect(back.state).toBe(CardState.Review);
    expect(back.ivl).toBe(10);
    expect(back.lapses).toBe(1);
  });

  it('lapse without relearning steps stays in review', () => {
    const s = nextStates(reviewCard(20), ctx({ conf: conf({ relearnSteps: [] }) }));
    expect(s[1].card.state).toBe(CardState.Review);
    expect(s[1].card.due).toBe(TODAY + 1);
  });

  it('respects the maximum interval', () => {
    const s = nextStates(reviewCard(300), ctx({ conf: conf({ maxIvl: 365 }) }));
    expect(s[4].card.ivl).toBe(365);
  });
});

describe('FSRS', () => {
  const fctx = (patch: Partial<SchedContext> = {}) => ctx({ scheduler: 'fsrs', ...patch });

  it('first rating sets the initial memory state', () => {
    const s = nextStates(newCard(), fctx());
    expect(s[3].card.stability).toBeCloseTo(2.3065, 4);
    expect(s[4].card.stability).toBeCloseTo(8.2956, 4);
    expect(s[4].card.state).toBe(CardState.Review);
    expect(s[4].card.ivl).toBe(8);
  });

  it('easy graduation is longer than good graduation', () => {
    const learning = newCard({ state: CardState.Learning, step: 1, reps: 1, stability: 2.3, difficulty: 5, lastReview: NOW - 600_000 });
    const s = nextStates(learning, fctx());
    expect(s[3].card.state).toBe(CardState.Review);
    expect(s[4].card.ivl).toBeGreaterThan(s[3].card.ivl);
  });

  it('review intervals grow and keep hard <= good < easy', () => {
    const card = reviewCard(10, 2.5, 10, { stability: 10, difficulty: 5 });
    const s = nextStates(card, fctx());
    expect(s[2].card.ivl).toBeLessThanOrEqual(s[3].card.ivl);
    expect(s[3].card.ivl).toBeGreaterThan(10);
    expect(s[4].card.ivl).toBeGreaterThan(s[3].card.ivl);
    expect(s[1].card.stability!).toBeLessThan(10);
    expect(s[1].card.state).toBe(CardState.Relearning);
  });

  it('lower desired retention gives longer intervals', () => {
    const card = reviewCard(10, 2.5, 10, { stability: 10, difficulty: 5 });
    const hi = nextStates(card, fctx({ conf: conf({ desiredRetention: 0.95 }) }));
    const lo = nextStates(card, fctx({ conf: conf({ desiredRetention: 0.8 }) }));
    expect(lo[3].card.ivl).toBeGreaterThan(hi[3].card.ivl);
  });

  it('derives memory from SM-2 data when switching schedulers', () => {
    const s = nextStates(reviewCard(30, 2.5), fctx());
    expect(s[3].card.stability).toBeGreaterThan(30);
    expect(s[3].card.difficulty).toBeGreaterThan(0);
  });
});

describe('fuzz', () => {
  it('matches Anki fuzz ranges', () => {
    expect(fuzzRange(1, 0)).toEqual([1, 1]);
    expect(fuzzRange(10, 0)).toEqual([8, 12]);
    expect(fuzzRange(10, 9)).toEqual([10, 12]);
    expect(fuzzRange(100, 0)).toEqual([93, 107]);
  });
  it('stays within the window and bounds', () => {
    for (let r = 0; r < 1; r += 0.05) {
      const v = constrainedIvl(100, 1, 36500, 0, true, r);
      expect(v).toBeGreaterThanOrEqual(93);
      expect(v).toBeLessThanOrEqual(107);
    }
    expect(constrainedIvl(100, 120, 36500, 0, true, 0)).toBe(120);
    expect(constrainedIvl(100, 1, 95, 0, true, 0.99)).toBe(95);
  });
  it('previews equal the actual outcome (deterministic seed)', () => {
    const card = reviewCard(40, 2.5);
    const a = nextStates(card, ctx({ fuzz: true }));
    const b = nextStates(card, ctx({ fuzz: true }));
    expect(a[3].card.ivl).toBe(b[3].card.ivl);
  });
});

describe('leeches', () => {
  it('triggers at the threshold and every half-threshold after', () => {
    expect(isLeech(7, 8)).toBe(false);
    expect(isLeech(8, 8)).toBe(true);
    expect(isLeech(10, 8)).toBe(false);
    expect(isLeech(12, 8)).toBe(true);
  });
});
