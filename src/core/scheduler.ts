import { type Card, CardState, type DeckConfig, type Rating, RevlogType, type SchedulerKind } from './types';
import { dayOf, dayStart } from './time';
import { intervalFor, memoryFromSm2, type MemoryState, nextMemoryState, normalizeWeights } from './fsrs';

export interface SchedContext {
  now: number;
  /** Day number of `now`. */
  today: number;
  rolloverHour: number;
  conf: DeckConfig;
  scheduler: SchedulerKind;
  fuzz: boolean;
}

export interface Outcome {
  card: Card;
  revlogType: RevlogType;
  /** Interval recorded in the review log: days if positive, seconds if negative. */
  revlogIvl: number;
  lastIvl: number;
  /** Seconds until the card is next due, for the button labels. */
  secs: number;
  /** The card just hit the leech threshold. */
  leech: boolean;
}

export const RATINGS: Rating[] = [1, 2, 3, 4];

/** Mulberry32 seeded by card id and repetition count, so button previews equal actual results. */
export function seededRandom(cardId: number, reps: number): number {
  let t = (Math.imul(cardId % 2147483647 | 0, 2654435761) ^ Math.imul(reps + 1, 1597334677)) >>> 0;
  t = (t + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Infinity, factor: 0.05 },
];

/** Anki's fuzz window for an interval. */
export function fuzzRange(ivl: number, elapsed: number): [number, number] {
  if (ivl < 2.5) return [Math.round(ivl), Math.round(ivl)];
  let delta = 1;
  for (const r of FUZZ_RANGES) delta += r.factor * Math.max(Math.min(ivl, r.end) - r.start, 0);
  let lo = Math.max(2, Math.round(ivl - delta));
  const hi = Math.round(ivl + delta);
  if (ivl > elapsed) lo = Math.max(lo, elapsed + 1);
  return [Math.min(lo, hi), hi];
}

/** Rounds, fuzzes and bounds an interval: result is in [minimum, maxIvl]. */
export function constrainedIvl(
  raw: number,
  minimum: number,
  maxIvl: number,
  elapsed: number,
  fuzz: boolean,
  rand: number,
): number {
  const ivl = Math.max(1, Math.round(raw));
  let [lo, hi] = fuzz ? fuzzRange(ivl, elapsed) : [ivl, ivl];
  lo = Math.min(Math.max(lo, minimum), maxIvl);
  hi = Math.min(Math.max(hi, minimum), maxIvl);
  return Math.max(1, Math.min(Math.floor(rand * (hi - lo + 1) + lo), hi));
}

type StepResult = { kind: 'step'; step: number; mins: number } | { kind: 'graduate'; easy: boolean };

/** Anki's (re)learning step rules. */
export function stepOutcome(steps: number[], current: number, g: Rating): StepResult {
  if (steps.length === 0) return { kind: 'graduate', easy: g === 4 };
  const cur = Math.min(current, steps.length - 1);
  switch (g) {
    case 1:
      return { kind: 'step', step: 0, mins: steps[0] };
    case 2: {
      let mins: number;
      if (cur === 0) {
        mins = steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(steps[0] * 1.5, steps[0] + 1440);
      } else {
        mins = steps[cur];
      }
      return { kind: 'step', step: cur, mins };
    }
    case 3:
      if (cur + 1 >= steps.length) return { kind: 'graduate', easy: false };
      return { kind: 'step', step: cur + 1, mins: steps[cur + 1] };
    case 4:
      return { kind: 'graduate', easy: true };
  }
}

export function elapsedDays(card: Card, ctx: Pick<SchedContext, 'today' | 'rolloverHour'>): number {
  if (!card.lastReview) return 0;
  return Math.max(0, ctx.today - dayOf(card.lastReview, ctx.rolloverHour));
}

/** The card's current FSRS memory state, approximating one from SM-2 data if it has none. */
export function currentMemory(card: Card, w: readonly number[], retention: number): MemoryState | null {
  if (card.stability && card.difficulty) return { stability: card.stability, difficulty: card.difficulty };
  if (card.state === CardState.Review || card.state === CardState.Relearning) {
    return memoryFromSm2(w, card.ivl, card.ease, retention);
  }
  return null;
}

/** Computes what each of the four ratings would do to the card. */
export function nextStates(card: Card, ctx: SchedContext): Record<Rating, Outcome> {
  const { conf, now, today } = ctx;
  const fsrs = ctx.scheduler === 'fsrs';
  const w = normalizeWeights(conf.fsrsParams);
  const retention = conf.desiredRetention;
  const elapsed = elapsedDays(card, ctx);
  const rand = seededRandom(card.id, card.reps);
  const prevMem = currentMemory(card, w, retention);
  const mems = Object.fromEntries(
    RATINGS.map((g) => [g, nextMemoryState(w, card.state === CardState.New ? null : prevMem, elapsed, g)]),
  ) as Record<Rating, MemoryState>;

  const base = (g: Rating): Card => ({
    ...card,
    reps: card.reps + 1,
    lastReview: now,
    mod: now,
    stability: mems[g].stability,
    difficulty: mems[g].difficulty,
  });
  const fsrsIvl = (g: Rating) => intervalFor(w, mems[g].stability, retention);
  const fit = (raw: number, minimum: number) =>
    constrainedIvl(raw, minimum, conf.maxIvl, elapsed, ctx.fuzz, rand);
  const lastIvl =
    card.state === CardState.Review || card.state === CardState.Relearning ? card.ivl : 0;

  const learnStep = (c: Card, state: CardState, step: number, mins: number, type: RevlogType): Outcome => {
    c.state = state;
    c.step = step;
    let secs = Math.round(mins * 60);
    if (mins >= 1440) {
      const days = Math.max(1, Math.round(mins / 1440));
      c.due = dayStart(today + days, ctx.rolloverHour);
      secs = days * 86400;
    } else {
      c.due = now + secs * 1000;
    }
    return { card: c, revlogType: type, revlogIvl: -secs, lastIvl, secs, leech: false };
  };
  const toReview = (c: Card, ivl: number, type: RevlogType): Outcome => {
    c.state = CardState.Review;
    c.step = 0;
    c.ivl = ivl;
    c.due = today + ivl;
    return { card: c, revlogType: type, revlogIvl: ivl, lastIvl, secs: ivl * 86400, leech: false };
  };

  const out = {} as Record<Rating, Outcome>;

  if (card.state === CardState.New || card.state === CardState.Learning) {
    const steps = conf.learnSteps;
    const cur = card.state === CardState.New ? 0 : card.step;
    let goodGradIvl = 0;
    for (const g of RATINGS) {
      const c = base(g);
      const res = stepOutcome(steps, cur, g);
      if (res.kind === 'step') {
        out[g] = learnStep(c, CardState.Learning, res.step, res.mins, RevlogType.Learn);
        continue;
      }
      c.ease = conf.startingEase;
      let ivl: number;
      if (fsrs) {
        ivl = fit(fsrsIvl(g), res.easy && goodGradIvl ? goodGradIvl + 1 : 1);
      } else {
        const raw = res.easy ? conf.easyIvl : conf.graduatingIvl;
        ivl = fit(raw, res.easy && goodGradIvl ? goodGradIvl + 1 : 1);
      }
      if (g === 3) goodGradIvl = ivl;
      out[g] = toReview(c, ivl, RevlogType.Learn);
    }
    return out;
  }

  if (card.state === CardState.Review) {
    // Again: lapse
    {
      const c = base(1);
      c.lapses = card.lapses + 1;
      c.ease = Math.max(1.3, (card.ease || conf.startingEase) - 0.2);
      const lapseIvl = fsrs
        ? fit(Math.min(fsrsIvl(1), card.ivl), 1)
        : Math.max(conf.minIvl, Math.round(card.ivl * conf.lapseMult), 1);
      let o: Outcome;
      if (conf.relearnSteps.length) {
        c.ivl = lapseIvl;
        o = learnStep(c, CardState.Relearning, 0, conf.relearnSteps[0], RevlogType.Review);
      } else {
        o = toReview(c, lapseIvl, RevlogType.Review);
      }
      o.leech = isLeech(c.lapses, conf.leechThreshold);
      out[1] = o;
    }
    const ease = card.ease || conf.startingEase;
    let hardRaw: number, goodRaw: number, easyRaw: number, hardMin: number;
    if (fsrs) {
      goodRaw = fsrsIvl(3);
      hardRaw = Math.min(fsrsIvl(2), goodRaw);
      easyRaw = fsrsIvl(4);
      hardMin = 1;
    } else {
      const late = elapsed - card.ivl;
      const mod = conf.ivlModifier;
      hardRaw = card.ivl * conf.hardFactor * mod;
      goodRaw = (card.ivl + late / 2) * ease * mod;
      easyRaw = (card.ivl + late) * ease * conf.easyBonus * mod;
      hardMin = conf.hardFactor > 1 ? card.ivl + 1 : 1;
    }
    const hard = fit(hardRaw, hardMin);
    const good = fit(goodRaw, hard + 1);
    const easy = fit(easyRaw, good + 1);
    const ivls: Record<2 | 3 | 4, number> = { 2: hard, 3: good, 4: easy };
    const easeDelta: Record<2 | 3 | 4, number> = { 2: -0.15, 3: 0, 4: 0.15 };
    for (const g of [2, 3, 4] as const) {
      const c = base(g);
      c.ease = Math.max(1.3, ease + easeDelta[g]);
      out[g] = toReview(c, ivls[g], RevlogType.Review);
    }
    return out;
  }

  // Relearning
  const steps = conf.relearnSteps;
  let goodGradIvl = 0;
  for (const g of RATINGS) {
    const c = base(g);
    const res = stepOutcome(steps, card.step, g);
    if (res.kind === 'step') {
      out[g] = learnStep(c, CardState.Relearning, res.step, res.mins, RevlogType.Relearn);
      continue;
    }
    let ivl: number;
    if (fsrs) {
      ivl = fit(fsrsIvl(g), res.easy && goodGradIvl ? goodGradIvl + 1 : 1);
    } else {
      ivl = Math.max(1, card.ivl) + (res.easy ? 1 : 0);
    }
    if (g === 3) goodGradIvl = ivl;
    out[g] = toReview(c, ivl, RevlogType.Relearn);
  }
  return out;
}

export function isLeech(lapses: number, threshold: number): boolean {
  if (threshold <= 0 || lapses < threshold) return false;
  const every = Math.max(1, Math.ceil(threshold / 2));
  return (lapses - threshold) % every === 0;
}

export const DEFAULT_CONFIG: Omit<DeckConfig, 'id' | 'name' | 'mod'> = {
  newPerDay: 20,
  revPerDay: 200,
  learnSteps: [1, 10],
  relearnSteps: [10],
  graduatingIvl: 1,
  easyIvl: 4,
  startingEase: 2.5,
  easyBonus: 1.3,
  hardFactor: 1.2,
  ivlModifier: 1,
  maxIvl: 36500,
  lapseMult: 0,
  minIvl: 1,
  leechThreshold: 8,
  leechAction: 'tag',
  buryNew: false,
  buryReview: false,
  buryInterday: false,
  newOrder: 'due',
  newGather: 'deck',
  reviewSort: 'due',
  newMix: 'mix',
  desiredRetention: 0.9,
  fsrsParams: [],
};
