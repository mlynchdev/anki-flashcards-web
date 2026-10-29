import { type Card, CardState, type Revlog } from './types';
import { dayOf } from './time';

/** Review intervals of at least this many days count as "mature" (as in Anki). */
export const MATURE_IVL = 21;

const DAY_MS = 86_400_000;

// ---------- scope ----------

/** The deck a card belongs to for statistics: its home deck while in a filtered deck. */
export function homeDeck(c: Card): number {
  return c.odid ?? c.deckId;
}

/** Cards whose home deck is in `deckIds`; `null` means the whole collection. */
export function scopeCards(cards: Iterable<Card>, deckIds: Set<number> | null): Card[] {
  const out: Card[] = [];
  for (const c of cards) if (!deckIds || deckIds.has(homeDeck(c))) out.push(c);
  return out;
}

/** Revlog entries of the given cards; `null` keeps everything (including entries of deleted cards). */
export function scopeRevlog(revlog: Iterable<Revlog>, cardIds: Set<number> | null): Revlog[] {
  const out: Revlog[] = [];
  for (const r of revlog) if (!cardIds || cardIds.has(r.cardId)) out.push(r);
  return out;
}

/** An actual answer, as opposed to a manual reschedule. */
export function isAnswer(r: Revlog): boolean {
  return r.ease > 0 && r.type !== 4;
}

// ---------- periods ----------

export type Period = '1m' | '3m' | '1y' | 'all';

export const PERIOD_DAYS: Record<Exclude<Period, 'all'>, number> = { '1m': 30, '3m': 90, '1y': 365 };

/** Number of days to look back (including today) for a period. */
export function backDays(period: Period, revlog: Revlog[], today: number, rolloverHour: number): number {
  if (period !== 'all') return PERIOD_DAYS[period];
  let first = today;
  for (const r of revlog) {
    const d = dayOf(r.id, rolloverHour);
    if (d < first) first = d;
  }
  return Math.max(30, today - first + 1);
}

/** Number of days to look ahead for the forecast (max 365). */
export function aheadDays(period: Period): number {
  return period === 'all' ? 365 : PERIOD_DAYS[period];
}

// ---------- today ----------

export interface TodayStats {
  /** Distinct cards answered. */
  cards: number;
  answers: number;
  timeMs: number;
  /** Average seconds per studied card. */
  secsPerCard: number;
  again: number;
  /** Fraction of answers that were not Again (0-1), or undefined with no answers. */
  correct?: number;
  learn: number;
  review: number;
  relearn: number;
  filtered: number;
  matureAnswers: number;
  matureCorrect?: number;
}

export function todayStats(revlog: Revlog[], today: number, rolloverHour: number): TodayStats {
  const seen = new Set<number>();
  const s: TodayStats = {
    cards: 0,
    answers: 0,
    timeMs: 0,
    secsPerCard: 0,
    again: 0,
    learn: 0,
    review: 0,
    relearn: 0,
    filtered: 0,
    matureAnswers: 0,
  };
  let matureOk = 0;
  for (const r of revlog) {
    if (!isAnswer(r) || dayOf(r.id, rolloverHour) !== today) continue;
    seen.add(r.cardId);
    s.answers++;
    s.timeMs += r.time;
    if (r.ease === 1) s.again++;
    if (r.type === 0) s.learn++;
    else if (r.type === 1) s.review++;
    else if (r.type === 2) s.relearn++;
    else if (r.type === 3) s.filtered++;
    if (r.type === 1 && r.lastIvl >= MATURE_IVL) {
      s.matureAnswers++;
      if (r.ease > 1) matureOk++;
    }
  }
  s.cards = seen.size;
  s.secsPerCard = s.cards ? s.timeMs / 1000 / s.cards : 0;
  if (s.answers) s.correct = (s.answers - s.again) / s.answers;
  if (s.matureAnswers) s.matureCorrect = matureOk / s.matureAnswers;
  return s;
}

// ---------- forecast ----------

export interface Forecast {
  /** counts[i] = review cards due i days from today; overdue cards are folded into counts[0]. */
  counts: number[];
  cumulative: number[];
  overdue: number;
  dueTomorrow: number;
  /** Sum of 1/ivl over scheduled review cards: the expected reviews per day in steady state. */
  dailyLoad: number;
  total: number;
}

export function forecast(cards: Card[], today: number, days: number): Forecast {
  const counts = new Array<number>(days + 1).fill(0);
  let overdue = 0;
  let load = 0;
  for (const c of cards) {
    if (c.state !== CardState.Review || c.suspended) continue;
    if (c.ivl > 0) load += 1 / c.ivl;
    const off = c.due - today;
    if (off < 0) {
      overdue++;
      counts[0]++;
    } else if (off <= days) counts[off]++;
  }
  const cumulative: number[] = [];
  let sum = 0;
  for (const n of counts) cumulative.push((sum += n));
  return { counts, cumulative, overdue, dueTomorrow: counts[1] ?? 0, dailyLoad: load, total: sum };
}

// ---------- reviews per day ----------

export const REVIEW_KINDS = ['learn', 'young', 'mature', 'relearn', 'filtered'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface DayBucket {
  /** Day number of the first day covered. */
  day: number;
  /** Number of days covered (1 unless grouped). */
  span: number;
  counts: Record<ReviewKind, number>;
  /** Milliseconds spent per kind. */
  times: Record<ReviewKind, number>;
}

function emptyKinds(): Record<ReviewKind, number> {
  return { learn: 0, young: 0, mature: 0, relearn: 0, filtered: 0 };
}

export function reviewKind(r: Revlog): ReviewKind | undefined {
  switch (r.type) {
    case 0:
      return 'learn';
    case 1:
      return r.lastIvl >= MATURE_IVL ? 'mature' : 'young';
    case 2:
      return 'relearn';
    case 3:
      return 'filtered';
    default:
      return undefined;
  }
}

export const bucketTotal = (b: DayBucket) => REVIEW_KINDS.reduce((n, k) => n + b.counts[k], 0);
export const bucketTime = (b: DayBucket) => REVIEW_KINDS.reduce((n, k) => n + b.times[k], 0);

/** One bucket per day for the last `days` days, oldest first; the last bucket is today. */
export function reviewsPerDay(revlog: Revlog[], today: number, rolloverHour: number, days: number): DayBucket[] {
  const first = today - days + 1;
  const out: DayBucket[] = [];
  for (let i = 0; i < days; i++) out.push({ day: first + i, span: 1, counts: emptyKinds(), times: emptyKinds() });
  for (const r of revlog) {
    const kind = reviewKind(r);
    if (!kind || r.ease === 0) continue;
    const idx = dayOf(r.id, rolloverHour) - first;
    if (idx < 0 || idx >= days) continue;
    out[idx].counts[kind]++;
    out[idx].times[kind] += r.time;
  }
  return out;
}

/** Merges consecutive buckets into groups of `size` days. */
export function groupBuckets(buckets: DayBucket[], size: number): DayBucket[] {
  if (size <= 1) return buckets;
  const out: DayBucket[] = [];
  for (let i = 0; i < buckets.length; i += size) {
    const g: DayBucket = { day: buckets[i].day, span: 0, counts: emptyKinds(), times: emptyKinds() };
    for (const b of buckets.slice(i, i + size)) {
      g.span += b.span;
      for (const k of REVIEW_KINDS) {
        g.counts[k] += b.counts[k];
        g.times[k] += b.times[k];
      }
    }
    out.push(g);
  }
  return out;
}

/** Sums consecutive values in groups of `size`. */
export function sumGroups(values: number[], size: number): number[] {
  if (size <= 1) return values;
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) {
    let s = 0;
    for (let j = i; j < Math.min(values.length, i + size); j++) s += values[j];
    out.push(s);
  }
  return out;
}

export interface ReviewTotals {
  daysStudied: number;
  days: number;
  total: number;
  timeMs: number;
  /** Average reviews per studied day. */
  avgPerStudiedDay: number;
  avgTimePerStudiedDayMs: number;
  /** Average reviews over every day of the period. */
  avgPerDay: number;
}

/** Totals over one-day buckets (call before grouping). */
export function reviewTotals(buckets: DayBucket[]): ReviewTotals {
  let studied = 0;
  let total = 0;
  let time = 0;
  let days = 0;
  for (const b of buckets) {
    const n = bucketTotal(b);
    days += b.span;
    if (n > 0) studied++;
    total += n;
    time += bucketTime(b);
  }
  return {
    daysStudied: studied,
    days,
    total,
    timeMs: time,
    avgPerStudiedDay: studied ? total / studied : 0,
    avgTimePerStudiedDayMs: studied ? time / studied : 0,
    avgPerDay: days ? total / days : 0,
  };
}

// ---------- card counts ----------

export interface CardCounts {
  new: number;
  learning: number;
  relearning: number;
  young: number;
  mature: number;
  suspended: number;
  buried: number;
  total: number;
}

/** Every card falls in exactly one class; suspended and buried take precedence over its state. */
export function cardCounts(cards: Card[]): CardCounts {
  const n: CardCounts = { new: 0, learning: 0, relearning: 0, young: 0, mature: 0, suspended: 0, buried: 0, total: 0 };
  for (const c of cards) {
    n.total++;
    if (c.suspended) n.suspended++;
    else if (c.buried) n.buried++;
    else if (c.state === CardState.New) n.new++;
    else if (c.state === CardState.Learning) n.learning++;
    else if (c.state === CardState.Relearning) n.relearning++;
    else if (c.ivl >= MATURE_IVL) n.mature++;
    else n.young++;
  }
  return n;
}

// ---------- histograms ----------

export interface Bin {
  lo: number;
  hi: number;
  count: number;
}

export interface Histogram {
  bins: Bin[];
  count: number;
  avg: number;
  min: number;
  max: number;
}

/** Smallest "nice" step (1, 2, 5, 10, 20, 50, ...) giving at most `target` bins over `range`. */
export function niceStep(range: number, target = 30): number {
  const raw = range / target;
  if (raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

/**
 * Buckets values into bins of width `step` starting at `lo`. With `nBins`, the result has exactly
 * that many bins and values outside are clamped into the first/last bin.
 */
export function histogram(values: number[], step: number, lo = 0, nBins?: number): Histogram {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  if (!values.length) return { bins: [], count: 0, avg: 0, min: 0, max: 0 };
  const n = nBins ?? Math.min(500, Math.max(1, Math.floor((max - lo) / step) + 1));
  const bins: Bin[] = [];
  for (let i = 0; i < n; i++) bins.push({ lo: lo + i * step, hi: lo + (i + 1) * step, count: 0 });
  for (const v of values) bins[Math.min(n - 1, Math.max(0, Math.floor((v - lo) / step)))].count++;
  return { bins, count: values.length, avg: sum / values.length, min, max };
}

/** Intervals (days) of review cards, with an adaptive bucket size. */
export function intervalHistogram(cards: Card[]): Histogram & { step: number } {
  const v = cards.filter((c) => c.state === CardState.Review && c.ivl > 0).map((c) => c.ivl);
  const max = v.reduce((m, x) => Math.max(m, x), 0);
  const step = niceStep(max);
  return { ...histogram(v, step, 0), step };
}

/** SM-2 ease in percent, 10% buckets. */
export function easeHistogram(cards: Card[]): Histogram {
  const v = cards.filter((c) => c.ease > 0 && c.state !== CardState.New).map((c) => Math.round(c.ease * 100));
  const min = v.reduce((m, x) => Math.min(m, x), Infinity);
  return histogram(v, 10, v.length ? Math.floor(min / 10) * 10 : 0);
}

/** FSRS difficulty as (d-1)/9 in percent, ten buckets. */
export function difficultyHistogram(cards: Card[]): Histogram {
  const v = cards
    .filter((c) => c.difficulty !== undefined && c.state !== CardState.New)
    .map((c) => ((c.difficulty as number) - 1) / 9 * 100);
  return histogram(v, 10, 0, 10);
}

/** FSRS stability in days. */
export function stabilityHistogram(cards: Card[]): Histogram & { step: number } {
  const v = cards
    .filter((c) => c.stability !== undefined && c.stability > 0 && c.state !== CardState.New)
    .map((c) => c.stability as number);
  const max = v.reduce((m, x) => Math.max(m, x), 0);
  const step = niceStep(max);
  return { ...histogram(v, step, 0), step };
}

/** Retrievability fractions (0-1), 5% buckets. */
export function retrievabilityHistogram(values: number[]): Histogram {
  return histogram(
    values.map((x) => x * 100),
    5,
    0,
    20,
  );
}

// ---------- heatmap ----------

/** Weekday of a day number: 0 = Sunday. Day 0 (1970-01-01) was a Thursday. */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

export interface HeatCell {
  day: number;
  count: number;
  /** Column (week) and row (weekday, 0 = Sunday). */
  col: number;
  row: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface Heatmap {
  cells: HeatCell[];
  weeks: number;
  max: number;
  total: number;
  daysStudied: number;
  longestStreak: number;
  currentStreak: number;
}

export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / max) * 4))) as 1 | 2 | 3 | 4;
}

/** Review counts for the last `days` days laid out in week columns starting on Sunday. */
export function heatmap(revlog: Revlog[], today: number, rolloverHour: number, days = 365): Heatmap {
  const first = today - days + 1;
  const counts = new Array<number>(days).fill(0);
  for (const r of revlog) {
    if (!isAnswer(r)) continue;
    const i = dayOf(r.id, rolloverHour) - first;
    if (i >= 0 && i < days) counts[i]++;
  }
  const gridStart = first - weekdayOf(first);
  let max = 0;
  let total = 0;
  let studied = 0;
  let longest = 0;
  let run = 0;
  for (const n of counts) {
    if (n > max) max = n;
    total += n;
    if (n > 0) {
      studied++;
      run++;
      if (run > longest) longest = run;
    } else run = 0;
  }
  // The current streak survives a day on which nothing has been studied yet.
  let current = 0;
  let i = days - 1;
  if (counts[i] === 0) i--;
  for (; i >= 0 && counts[i] > 0; i--) current++;
  const cells: HeatCell[] = counts.map((count, k) => {
    const day = first + k;
    return {
      day,
      count,
      col: Math.floor((day - gridStart) / 7),
      row: weekdayOf(day),
      level: heatLevel(count, max),
    };
  });
  return {
    cells,
    weeks: Math.floor((today - gridStart) / 7) + 1,
    max,
    total,
    daysStudied: studied,
    longestStreak: longest,
    currentStreak: current,
  };
}

// ---------- hourly ----------

export interface HourBucket {
  hour: number;
  count: number;
  correct: number;
}

/** Answers per local hour of day over the last `days` days. */
export function hourly(revlog: Revlog[], today: number, rolloverHour: number, days: number): HourBucket[] {
  const first = today - days + 1;
  const out: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, correct: 0 }));
  for (const r of revlog) {
    if (!isAnswer(r) || dayOf(r.id, rolloverHour) < first) continue;
    const b = out[new Date(r.id).getHours()];
    b.count++;
    if (r.ease > 1) b.correct++;
  }
  return out;
}

// ---------- answer buttons ----------

export type ButtonGroup = 'learning' | 'young' | 'mature';

export interface AnswerButtons {
  /** counts[group][ease - 1] */
  counts: Record<ButtonGroup, [number, number, number, number]>;
}

export function answerButtons(revlog: Revlog[], today: number, rolloverHour: number, days: number): AnswerButtons {
  const first = today - days + 1;
  const counts: AnswerButtons['counts'] = {
    learning: [0, 0, 0, 0],
    young: [0, 0, 0, 0],
    mature: [0, 0, 0, 0],
  };
  for (const r of revlog) {
    if (!isAnswer(r) || r.type === 3) continue;
    if (dayOf(r.id, rolloverHour) < first) continue;
    const group: ButtonGroup = r.type === 1 ? (r.lastIvl >= MATURE_IVL ? 'mature' : 'young') : 'learning';
    counts[group][r.ease - 1]++;
  }
  return { counts };
}

// ---------- true retention ----------

export interface RetentionRow {
  label: string;
  youngPass: number;
  youngFail: number;
  maturePass: number;
  matureFail: number;
}

export const retentionRate = (pass: number, fail: number): number | undefined =>
  pass + fail ? pass / (pass + fail) : undefined;

/**
 * Review-type answers split by pass/fail for fixed windows ending today. "Last week", "Last month"
 * and "Last year" cover the last 7, 30 and 365 days including today.
 */
export function trueRetention(revlog: Revlog[], today: number, rolloverHour: number): RetentionRow[] {
  const windows: { label: string; from: number; to: number }[] = [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: today - 1, to: today - 1 },
    { label: 'Last week', from: today - 6, to: today },
    { label: 'Last month', from: today - 29, to: today },
    { label: 'Last year', from: today - 364, to: today },
    { label: 'All time', from: -Infinity, to: Infinity },
  ];
  const rows: RetentionRow[] = windows.map((w) => ({
    label: w.label,
    youngPass: 0,
    youngFail: 0,
    maturePass: 0,
    matureFail: 0,
  }));
  for (const r of revlog) {
    if (r.type !== 1 || r.ease <= 0) continue;
    const d = dayOf(r.id, rolloverHour);
    const mature = r.lastIvl >= MATURE_IVL;
    const pass = r.ease > 1;
    for (let i = 0; i < windows.length; i++) {
      if (d < windows[i].from || d > windows[i].to) continue;
      const row = rows[i];
      if (mature) pass ? row.maturePass++ : row.matureFail++;
      else pass ? row.youngPass++ : row.youngFail++;
    }
  }
  return rows;
}

// ---------- formatting ----------

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`.replace(/ 0s$/, '');
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatPercent(x: number | undefined, digits = 0): string {
  return x === undefined || Number.isNaN(x) ? '-' : `${(x * 100).toFixed(digits)}%`;
}

/** "Oct 29" for a day number. */
export function formatDay(day: number): string {
  return new Date(day * DAY_MS).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
