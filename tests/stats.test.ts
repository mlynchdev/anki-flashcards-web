import { describe, expect, it } from 'vitest';
import { type Card, CardState, type Revlog } from '../src/core/types';
import { dayOf, dayStart } from '../src/core/time';
import {
  answerButtons,
  bucketTotal,
  cardCounts,
  difficultyHistogram,
  forecast,
  formatDuration,
  groupBuckets,
  heatmap,
  histogram,
  intervalHistogram,
  niceStep,
  reviewTotals,
  reviewsPerDay,
  scopeCards,
  scopeRevlog,
  todayStats,
  trueRetention,
  weekdayOf,
} from '../src/core/stats';

const ROLL = 4;
// Thursday 2026-10-29, noon local.
const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime();
const TODAY = dayOf(NOW, ROLL);

function card(patch: Partial<Card> = {}): Card {
  return {
    id: 1,
    noteId: 1,
    deckId: 1,
    ord: 0,
    state: CardState.Review,
    due: TODAY,
    ivl: 10,
    ease: 2.5,
    reps: 1,
    lapses: 0,
    step: 0,
    suspended: false,
    buried: 0,
    flag: 0,
    mod: 0,
    ...patch,
  };
}

let nextId = 1;
/** Revlog entry `daysAgo` days before today at the given local hour. */
function rev(daysAgo: number, patch: Partial<Revlog> = {}, hour = 12): Revlog {
  const ts = dayStart(TODAY - daysAgo, ROLL) + (hour - ROLL) * 3_600_000 + nextId++;
  return {
    id: ts,
    cardId: 1,
    ease: 3,
    ivl: 10,
    lastIvl: 5,
    factor: 2500,
    time: 4000,
    type: 1,
    ...patch,
  };
}

describe('scope', () => {
  it('uses the home deck for cards in filtered decks', () => {
    const cards = [card({ id: 1, deckId: 1 }), card({ id: 2, deckId: 9, odid: 1 }), card({ id: 3, deckId: 2 })];
    expect(scopeCards(cards, new Set([1])).map((c) => c.id)).toEqual([1, 2]);
    expect(scopeCards(cards, null)).toHaveLength(3);
    const log = [rev(0, { cardId: 1 }), rev(0, { cardId: 3 })];
    expect(scopeRevlog(log, new Set([1]))).toHaveLength(1);
  });
});

describe('forecast', () => {
  it('buckets review cards by due day and folds overdue into day 0', () => {
    const cards = [
      card({ due: TODAY - 5 }),
      card({ due: TODAY }),
      card({ due: TODAY + 1 }),
      card({ due: TODAY + 1 }),
      card({ due: TODAY + 3 }),
      card({ due: TODAY + 99 }), // beyond range
      card({ due: TODAY + 1, suspended: true }),
      card({ state: CardState.New, due: 5 }),
    ];
    const f = forecast(cards, TODAY, 7);
    expect(f.counts).toHaveLength(8);
    expect(f.counts).toEqual([2, 2, 0, 1, 0, 0, 0, 0]);
    expect(f.overdue).toBe(1);
    expect(f.dueTomorrow).toBe(2);
    expect(f.cumulative.at(-1)).toBe(5);
    expect(f.cumulative.slice(0, 2)).toEqual([2, 4]);
  });

  it('computes the daily load as the sum of 1/ivl', () => {
    const f = forecast([card({ ivl: 2 }), card({ ivl: 4 }), card({ ivl: 10, suspended: true })], TODAY, 30);
    expect(f.dailyLoad).toBeCloseTo(0.75);
  });
});

describe('reviewsPerDay', () => {
  const log = [
    rev(0, { type: 0, lastIvl: 0 }),
    rev(0, { type: 1, lastIvl: 5 }),
    rev(0, { type: 1, lastIvl: 30 }),
    rev(0, { type: 2 }),
    rev(0, { type: 3 }),
    rev(0, { type: 4, ease: 0 }), // manual: ignored
    rev(2, { type: 1, lastIvl: 21, time: 6000 }),
    rev(40, { type: 1 }), // outside a 30 day window
  ];

  it('stacks by kind and splits young from mature at 21 days', () => {
    const days = reviewsPerDay(log, TODAY, ROLL, 30);
    expect(days).toHaveLength(30);
    expect(days[29].day).toBe(TODAY);
    expect(days[29].counts).toEqual({ learn: 1, young: 1, mature: 1, relearn: 1, filtered: 1 });
    expect(days[27].counts.mature).toBe(1);
    expect(days[27].times.mature).toBe(6000);
    expect(days.reduce((n, d) => n + bucketTotal(d), 0)).toBe(6);
  });

  it('computes totals and groups buckets', () => {
    const days = reviewsPerDay(log, TODAY, ROLL, 30);
    const t = reviewTotals(days);
    expect(t.daysStudied).toBe(2);
    expect(t.total).toBe(6);
    expect(t.avgPerStudiedDay).toBe(3);
    const grouped = groupBuckets(days, 7);
    expect(grouped).toHaveLength(5);
    expect(grouped.reduce((n, d) => n + bucketTotal(d), 0)).toBe(6);
    expect(grouped.reduce((n, d) => n + d.span, 0)).toBe(30);
  });

  it('respects the rollover hour when assigning days', () => {
    const justBefore = new Date(2026, 9, 29, 3, 59).getTime(); // still "yesterday"
    const justAfter = new Date(2026, 9, 29, 4, 1).getTime();
    const days = reviewsPerDay([rev(0, { id: justBefore }), rev(0, { id: justAfter })], TODAY, ROLL, 3);
    expect(days[1].counts.young).toBe(1);
    expect(days[2].counts.young).toBe(1);
  });
});

describe('todayStats', () => {
  it('summarises today only', () => {
    const log = [
      rev(0, { cardId: 1, ease: 1, type: 1, lastIvl: 30, time: 2000 }),
      rev(0, { cardId: 1, ease: 3, type: 2, time: 4000 }),
      rev(0, { cardId: 2, ease: 3, type: 1, lastIvl: 30, time: 6000 }),
      rev(0, { cardId: 3, ease: 4, type: 0, time: 8000 }),
      rev(1, { cardId: 4 }),
    ];
    const s = todayStats(log, TODAY, ROLL);
    expect(s.cards).toBe(3);
    expect(s.answers).toBe(4);
    expect(s.timeMs).toBe(20000);
    expect(s.secsPerCard).toBeCloseTo(20 / 3);
    expect(s.again).toBe(1);
    expect(s.correct).toBeCloseTo(0.75);
    expect([s.learn, s.review, s.relearn, s.filtered]).toEqual([1, 2, 1, 0]);
    expect(s.matureCorrect).toBeCloseTo(0.5);
  });

  it('leaves percentages undefined with no answers', () => {
    const s = todayStats([], TODAY, ROLL);
    expect(s.correct).toBeUndefined();
    expect(s.matureCorrect).toBeUndefined();
  });
});

describe('cardCounts', () => {
  it('classifies each card exactly once', () => {
    const cards = [
      card({ state: CardState.New }),
      card({ state: CardState.Learning }),
      card({ state: CardState.Relearning }),
      card({ state: CardState.Review, ivl: 20 }),
      card({ state: CardState.Review, ivl: 21 }),
      card({ state: CardState.Review, ivl: 100 }),
      card({ suspended: true, ivl: 100 }),
      card({ buried: 1, state: CardState.New }),
      card({ suspended: true, buried: 2 }),
    ];
    expect(cardCounts(cards)).toEqual({
      new: 1,
      learning: 1,
      relearning: 1,
      young: 1,
      mature: 2,
      suspended: 2,
      buried: 1,
      total: 9,
    });
  });
});

describe('trueRetention', () => {
  it('splits pass/fail by maturity and window, only for review entries', () => {
    const log = [
      rev(0, { ease: 3, lastIvl: 5 }), // young pass today
      rev(0, { ease: 1, lastIvl: 5 }), // young fail today
      rev(0, { ease: 4, lastIvl: 40 }), // mature pass today
      rev(0, { type: 0, ease: 1 }), // learn: ignored
      rev(0, { type: 4, ease: 0 }), // manual: ignored
      rev(1, { ease: 1, lastIvl: 40 }), // mature fail yesterday
      rev(5, { ease: 2, lastIvl: -600 }), // young pass last week
      rev(20, { ease: 3, lastIvl: 21 }), // mature pass last month
      rev(200, { ease: 3, lastIvl: 3 }), // young pass last year
      rev(500, { ease: 3, lastIvl: 3 }), // all time only
    ];
    const rows = Object.fromEntries(trueRetention(log, TODAY, ROLL).map((r) => [r.label, r]));
    expect(rows['Today']).toMatchObject({ youngPass: 1, youngFail: 1, maturePass: 1, matureFail: 0 });
    expect(rows['Yesterday']).toMatchObject({ youngPass: 0, youngFail: 0, maturePass: 0, matureFail: 1 });
    expect(rows['Last week']).toMatchObject({ youngPass: 2, youngFail: 1, maturePass: 1, matureFail: 1 });
    expect(rows['Last month']).toMatchObject({ youngPass: 2, youngFail: 1, maturePass: 2, matureFail: 1 });
    expect(rows['Last year']).toMatchObject({ youngPass: 3, youngFail: 1, maturePass: 2, matureFail: 1 });
    expect(rows['All time']).toMatchObject({ youngPass: 4, youngFail: 1, maturePass: 2, matureFail: 1 });
  });
});

describe('heatmap', () => {
  it('maps days to week columns and weekday rows', () => {
    expect(weekdayOf(TODAY)).toBe(4); // Thursday
    const log = [rev(0), rev(0), rev(0), rev(1), rev(7)];
    const h = heatmap(log, TODAY, ROLL, 365);
    expect(h.cells).toHaveLength(365);
    const today = h.cells.at(-1)!;
    expect(today).toMatchObject({ day: TODAY, count: 3, row: 4, level: 4, col: h.weeks - 1 });
    const yesterday = h.cells.at(-2)!;
    expect(yesterday).toMatchObject({ count: 1, row: 3, col: h.weeks - 1 });
    // Same weekday a week earlier is one column to the left.
    const weekAgo = h.cells.find((c) => c.day === TODAY - 7)!;
    expect(weekAgo).toMatchObject({ row: 4, col: h.weeks - 2, count: 1 });
    // The first cell sits in column 0 and no cell shares a (col,row).
    expect(h.cells[0].col).toBe(0);
    expect(new Set(h.cells.map((c) => `${c.col},${c.row}`)).size).toBe(365);
    expect(h.max).toBe(3);
    expect(h.total).toBe(5);
    expect(h.daysStudied).toBe(3);
    expect(h.currentStreak).toBe(2);
    expect(h.longestStreak).toBe(2);
  });

  it('keeps a streak alive when today has no reviews yet', () => {
    const h = heatmap([rev(1), rev(2), rev(3)], TODAY, ROLL, 30);
    expect(h.currentStreak).toBe(3);
  });
});

describe('answerButtons', () => {
  it('counts ratings per card maturity group', () => {
    const log = [
      rev(0, { type: 0, ease: 1 }),
      rev(0, { type: 2, ease: 3 }),
      rev(0, { type: 1, lastIvl: 5, ease: 4 }),
      rev(0, { type: 1, lastIvl: 50, ease: 2 }),
      rev(0, { type: 1, lastIvl: 50, ease: 2 }),
      rev(0, { type: 3, ease: 3 }),
    ];
    const { counts } = answerButtons(log, TODAY, ROLL, 30);
    expect(counts.learning).toEqual([1, 0, 1, 0]);
    expect(counts.young).toEqual([0, 0, 0, 1]);
    expect(counts.mature).toEqual([0, 2, 0, 0]);
  });
});

describe('histograms', () => {
  it('picks nice steps', () => {
    expect(niceStep(20)).toBe(1);
    expect(niceStep(365)).toBe(20);
    expect(niceStep(3000)).toBe(100);
  });

  it('bins values and tracks the average and max', () => {
    const h = histogram([1, 2, 2, 9], 5);
    expect(h.bins.map((b) => b.count)).toEqual([3, 1]);
    expect(h.avg).toBe(3.5);
    expect(h.max).toBe(9);
  });

  it('builds the interval histogram from review cards only', () => {
    const h = intervalHistogram([
      card({ ivl: 3 }),
      card({ ivl: 3 }),
      card({ ivl: 10 }),
      card({ state: CardState.Learning, ivl: 50 }),
    ]);
    expect(h.count).toBe(3);
    expect(h.max).toBe(10);
    expect(h.bins[3].count).toBe(2);
  });

  it('maps FSRS difficulty to (d-1)/9 percent buckets', () => {
    const h = difficultyHistogram([card({ difficulty: 1 }), card({ difficulty: 10 }), card({ difficulty: 5.5 })]);
    expect(h.bins).toHaveLength(10);
    expect(h.bins[0].count).toBe(1);
    expect(h.bins[5].count).toBe(1);
    expect(h.bins[9].count).toBe(1);
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});
