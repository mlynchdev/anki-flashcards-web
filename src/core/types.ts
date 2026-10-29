export const enum CardState {
  New = 0,
  Learning = 1,
  Review = 2,
  Relearning = 3,
}

export type Rating = 1 | 2 | 3 | 4;

export interface Card {
  id: number;
  noteId: number;
  deckId: number;
  /** Template index (standard notetypes) or cloze number - 1. */
  ord: number;
  state: CardState;
  /**
   * Meaning depends on state, as in Anki:
   * New: queue position. Learning/Relearning: due timestamp (ms). Review: day number.
   */
  due: number;
  /** Current interval in days (review cards; kept through relearning). */
  ivl: number;
  /** SM-2 ease factor, e.g. 2.5. 0 until the card first graduates. */
  ease: number;
  reps: number;
  lapses: number;
  /** Index of the current (re)learning step. */
  step: number;
  /** FSRS memory state. */
  stability?: number;
  difficulty?: number;
  /** Timestamp (ms) of the last rating. */
  lastReview?: number;
  suspended: boolean;
  /** 0 = not buried, 1 = buried by the scheduler (siblings), 2 = buried by the user. */
  buried: 0 | 1 | 2;
  /** Day on which the card was buried; it is unburied when the day rolls over. */
  buriedDay?: number;
  /** 0 = none, 1 red, 2 orange, 3 green, 4 blue, 5 pink, 6 turquoise, 7 purple. */
  flag: number;
  /** Home deck while the card sits in a filtered deck. */
  odid?: number;
  /** Original due while in a filtered deck. */
  odue?: number;
  mod: number;
}

export interface Note {
  id: number;
  guid: string;
  notetypeId: number;
  fields: string[];
  tags: string[];
  mod: number;
}

export interface CardTemplate {
  name: string;
  qfmt: string;
  afmt: string;
}

export interface Notetype {
  id: number;
  name: string;
  kind: 'standard' | 'cloze';
  fields: string[];
  templates: CardTemplate[];
  css: string;
  sortField: number;
  mod: number;
}

export type FilteredOrder =
  | 'random'
  | 'due'
  | 'added'
  | 'ivlAsc'
  | 'ivlDesc'
  | 'lapses'
  | 'retrievability';

export interface FilteredSpec {
  search: string;
  limit: number;
  order: FilteredOrder;
  reschedule: boolean;
}

export interface DeckToday {
  day: number;
  newDone: number;
  revDone: number;
  /** Extra allowance granted through Custom Study for this day. */
  newExtra: number;
  revExtra: number;
}

export interface Deck {
  id: number;
  /** Hierarchical name with `::` separators. */
  name: string;
  configId: number;
  description?: string;
  collapsed?: boolean;
  dyn?: FilteredSpec;
  today?: DeckToday;
  mod: number;
}

export type NewMix = 'mix' | 'after' | 'before';
export type LeechAction = 'suspend' | 'tag';

export interface DeckConfig {
  id: number;
  name: string;
  newPerDay: number;
  revPerDay: number;
  /** Learning steps in minutes. */
  learnSteps: number[];
  relearnSteps: number[];
  graduatingIvl: number;
  easyIvl: number;
  startingEase: number;
  easyBonus: number;
  hardFactor: number;
  ivlModifier: number;
  maxIvl: number;
  /** Multiplier applied to the interval on a lapse (SM-2). */
  lapseMult: number;
  minIvl: number;
  leechThreshold: number;
  leechAction: LeechAction;
  buryNew: boolean;
  buryReview: boolean;
  buryInterday: boolean;
  newOrder: 'due' | 'random';
  newMix: NewMix;
  desiredRetention: number;
  /** FSRS weights; empty means use the defaults. */
  fsrsParams: number[];
  mod: number;
}

export const enum RevlogType {
  Learn = 0,
  Review = 1,
  Relearn = 2,
  Filtered = 3,
  Manual = 4,
}

export interface Revlog {
  /** Timestamp in ms; unique. */
  id: number;
  cardId: number;
  /** 1-4, or 0 for manual changes (forget, set due). */
  ease: 0 | Rating;
  /** New interval: positive days, negative seconds (learning). */
  ivl: number;
  lastIvl: number;
  /** Ease factor * 1000 (SM-2) or difficulty * 1000 after the review (FSRS). */
  factor: number;
  /** Milliseconds spent answering. */
  time: number;
  type: RevlogType;
  stability?: number;
  difficulty?: number;
}

export type SchedulerKind = 'fsrs' | 'sm2';
export type Theme = 'system' | 'light' | 'dark';
export type GestureAction =
  | 'none'
  | 'showAnswer'
  | 'again'
  | 'hard'
  | 'good'
  | 'easy'
  | 'undo'
  | 'bury'
  | 'suspend'
  | 'mark'
  | 'flag'
  | 'edit'
  | 'info'
  | 'replay';

export interface Settings {
  scheduler: SchedulerKind;
  rolloverHour: number;
  learnAheadMins: number;
  theme: Theme;
  fontScale: number;
  showIntervals: boolean;
  showRemaining: boolean;
  fuzz: boolean;
  /** Tap zones: left / center / right third of the card area, before and after the answer is shown. */
  tapQuestion: { left: GestureAction; center: GestureAction; right: GestureAction };
  tapAnswer: { left: GestureAction; center: GestureAction; right: GestureAction };
  swipe: { left: GestureAction; right: GestureAction; up: GestureAction; down: GestureAction };
  currentDeckId?: number;
  /** Ask to rate with the review limit shared with new cards (Anki v3 default). */
  newIgnoresReviewLimit: boolean;
}

export const FLAG_COLORS = ['', '#e5484d', '#f76b15', '#30a46c', '#3e63dd', '#d6409f', '#12a594', '#8e4ec6'];
export const FLAG_NAMES = ['No flag', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'];
