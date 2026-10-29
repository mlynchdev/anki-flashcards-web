import {
  type Card,
  CardState,
  type Deck,
  type DeckConfig,
  type FilteredSpec,
  type Note,
  type Notetype,
  type Rating,
  type Revlog,
  RevlogType,
  type Settings,
} from './types';
import type { Persistence, StoreName } from './db';
import { dayOf, dayStart } from './time';
import { DEFAULT_CONFIG, nextStates, type Outcome, type SchedContext, elapsedDays, currentMemory } from './scheduler';
import { builtinNotetypes } from './notetypes';
import { cardOrdinals } from './template';
import { compileSearch, type SearchEnv } from './search';
import { normalizeWeights, retrievability } from './fsrs';

export const DEFAULT_DECK_ID = 1;
export const DEFAULT_CONFIG_ID = 1;

export const DEFAULT_SETTINGS: Settings = {
  scheduler: 'fsrs',
  rolloverHour: 4,
  learnAheadMins: 20,
  theme: 'system',
  fontScale: 1,
  showIntervals: true,
  showRemaining: true,
  fuzz: true,
  tapQuestion: { left: 'showAnswer', center: 'showAnswer', right: 'showAnswer' },
  tapAnswer: { left: 'none', center: 'none', right: 'none' },
  swipe: { left: 'again', right: 'good', up: 'easy', down: 'hard' },
  newIgnoresReviewLimit: false,
};

export interface Counts {
  new: number;
  learn: number;
  review: number;
}

export interface DeckNode {
  deck: Deck;
  /** Last component of the name. */
  label: string;
  depth: number;
  children: DeckNode[];
  counts: Counts;
  total: number;
}

export interface StudySession {
  deckId: number;
  answered: number;
  sinceNew: number;
  lastCardId?: number;
  /** Preview-mode (non-rescheduling filtered deck) cards held back until the timestamp. */
  previewHold: Map<number, number>;
  startedAt: number;
}

export type NextCard =
  | { kind: 'card'; card: Card; queue: 'new' | 'learn' | 'review' }
  | { kind: 'wait'; until: number }
  | { kind: 'done' };

interface Gathered {
  news: Card[];
  reviews: Card[];
  learn: Card[];
}

interface UndoEntry {
  label: string;
  /** store -> key -> previous value (undefined = did not exist). */
  before: Map<StoreName, Map<number, unknown>>;
  /** Card answered, so the study screen can show it again. */
  cardId?: number;
}

type Listener = () => void;

const CLONE = <T>(v: T): T => structuredClone(v);

export class Collection {
  cards = new Map<number, Card>();
  notes = new Map<number, Note>();
  notetypes = new Map<number, Notetype>();
  decks = new Map<number, Deck>();
  configs = new Map<number, DeckConfig>();
  revlog = new Map<number, Revlog>();
  settings: Settings = CLONE(DEFAULT_SETTINGS);
  mediaNames = new Set<string>();

  private revlogByCard = new Map<number, Revlog[]>();
  private cardsByNote = new Map<number, number[]>();
  private cardsByDeck: Map<number, Card[]> | null = null;
  private puts = new Map<StoreName, Map<IDBValidKey, unknown>>();
  private dels = new Map<StoreName, Set<IDBValidKey>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();
  private op: UndoEntry | null = null;
  undoStack: UndoEntry[] = [];
  private lastId = 0;
  version = 0;
  /** Local changes not yet pushed to the sync server: `${store}:${id}` -> change time. */
  syncJournal = new Map<string, number>();
  syncState: { clientId: string; cursor: number } = { clientId: '', cursor: 0 };
  /** Local-only key/value data (not synced), e.g. the loaded content version. */
  localMeta: Record<string, unknown> = {};
  private applyingRemote = false;
  /** When set, journal entries get this timestamp instead of the current time. */
  private journalAt: number | undefined;
  /** Overridable clock for tests. */
  clock: () => number = () => Date.now();

  constructor(private persistence: Persistence) {}

  // ---------- lifecycle ----------

  async load() {
    const all = await this.persistence.loadAll();
    this.cards.clear();
    this.notes.clear();
    this.notetypes.clear();
    this.decks.clear();
    this.configs.clear();
    this.revlog.clear();
    for (const c of all.cards as Card[]) this.cards.set(c.id, c);
    for (const n of all.notes as Note[]) this.notes.set(n.id, n);
    for (const n of all.notetypes as Notetype[]) this.notetypes.set(n.id, n);
    for (const d of all.decks as Deck[]) this.decks.set(d.id, d);
    for (const c of all.configs as DeckConfig[]) this.configs.set(c.id, c);
    for (const r of all.revlog as Revlog[]) this.revlog.set(r.id, r);
    const meta = all.meta as { key: string; value: unknown }[];
    const s = meta.find((m) => m.key === 'settings');
    this.settings = { ...CLONE(DEFAULT_SETTINGS), ...((s?.value as Partial<Settings>) ?? {}) };
    const journal = meta.find((m) => m.key === 'syncJournal')?.value as [string, number][] | undefined;
    this.syncJournal = new Map(journal ?? []);
    const st = meta.find((m) => m.key === 'syncState')?.value as Collection['syncState'] | undefined;
    this.syncState = st?.clientId ? st : { clientId: randomGuid().replace(/[^a-zA-Z0-9]/g, 'x'), cursor: 0 };
    this.localMeta = (meta.find((m) => m.key === 'local')?.value as Record<string, unknown>) ?? {};
    const mediaNames = (this.persistence as { mediaNames?: () => Promise<string[]> }).mediaNames;
    if (mediaNames) this.mediaNames = new Set(await mediaNames.call(this.persistence));
    this.reindex();
    this.ensureDefaults();
    this.checkDayRollover();
    this.emit();
  }

  private ensureDefaults() {
    this.journalAt = 1;
    try {
      this.ensureDefaultsInner();
    } finally {
      this.journalAt = undefined;
    }
  }

  private ensureDefaultsInner() {
    const now = this.clock();
    for (const nt of builtinNotetypes(now)) if (!this.notetypes.has(nt.id)) this.put('notetypes', nt);
    if (!this.configs.has(DEFAULT_CONFIG_ID)) {
      this.put('configs', { ...CLONE(DEFAULT_CONFIG), id: DEFAULT_CONFIG_ID, name: 'Default', mod: now });
    }
    if (!this.decks.has(DEFAULT_DECK_ID)) {
      this.put('decks', { id: DEFAULT_DECK_ID, name: 'Default', configId: DEFAULT_CONFIG_ID, mod: now });
    }
  }

  private reindex() {
    this.revlogByCard.clear();
    for (const r of [...this.revlog.values()].sort((a, b) => a.id - b.id)) {
      const list = this.revlogByCard.get(r.cardId);
      if (list) list.push(r);
      else this.revlogByCard.set(r.cardId, [r]);
    }
    this.cardsByNote.clear();
    for (const c of this.cards.values()) {
      const list = this.cardsByNote.get(c.noteId);
      if (list) list.push(c.id);
      else this.cardsByNote.set(c.noteId, [c.id]);
    }
    this.cardsByDeck = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  newId(): number {
    const id = Math.max(this.clock(), this.lastId + 1);
    this.lastId = id;
    return id;
  }

  // ---------- persistence + undo ----------

  private mapFor(store: StoreName): Map<number, unknown> {
    switch (store) {
      case 'cards':
        return this.cards;
      case 'notes':
        return this.notes;
      case 'notetypes':
        return this.notetypes;
      case 'decks':
        return this.decks;
      case 'configs':
        return this.configs;
      case 'revlog':
        return this.revlog;
      default:
        throw new Error(`no map for ${store}`);
    }
  }

  private record(store: StoreName, id: number) {
    if (!this.op) return;
    let m = this.op.before.get(store);
    if (!m) this.op.before.set(store, (m = new Map()));
    if (!m.has(id)) {
      const prev = this.mapFor(store).get(id);
      m.set(id, prev === undefined ? undefined : CLONE(prev));
    }
  }

  private put<T extends { id: number }>(store: StoreName, value: T) {
    this.record(store, value.id);
    const map = this.mapFor(store) as Map<number, T>;
    const prev = map.get(value.id);
    map.set(value.id, value);
    if (store === 'cards') this.onCardChanged(prev as Card | undefined, value as unknown as Card);
    if (store === 'revlog') this.onRevlogChanged(prev as Revlog | undefined, value as unknown as Revlog);
    this.queuePut(store, value.id, value);
    this.journal(store, value.id);
  }

  private journal(store: string, id: number | string) {
    if (this.applyingRemote) return;
    const key = `${store}:${id}`;
    if (this.journalAt !== undefined) {
      // Low-priority write (defaults, shared content): any server copy wins.
      if (!this.syncJournal.has(key)) this.syncJournal.set(key, this.journalAt);
    } else {
      this.syncJournal.set(key, Math.max(this.clock(), (this.syncJournal.get(key) ?? 0) + 1));
    }
    this.journalDirty = true;
  }
  private journalDirty = false;

  private remove(store: StoreName, id: number) {
    this.record(store, id);
    const map = this.mapFor(store);
    const prev = map.get(id);
    if (prev === undefined) return;
    map.delete(id);
    if (store === 'cards') this.onCardChanged(prev as Card, undefined);
    if (store === 'revlog') this.onRevlogChanged(prev as Revlog, undefined);
    this.puts.get(store)?.delete(id);
    if (!this.dels.has(store)) this.dels.set(store, new Set());
    this.dels.get(store)!.add(id);
    this.scheduleFlush();
    this.journal(store, id);
  }

  private queuePut(store: StoreName, key: IDBValidKey, value: unknown) {
    if (!this.puts.has(store)) this.puts.set(store, new Map());
    this.puts.get(store)!.set(key, value);
    this.dels.get(store)?.delete(key);
    this.scheduleFlush();
  }

  private onCardChanged(prev: Card | undefined, next: Card | undefined) {
    this.cardsByDeck = null;
    if (prev && (!next || prev.noteId !== next.noteId)) {
      const list = this.cardsByNote.get(prev.noteId);
      if (list) {
        const i = list.indexOf(prev.id);
        if (i >= 0) list.splice(i, 1);
      }
    }
    if (next && (!prev || prev.noteId !== next.noteId)) {
      const list = this.cardsByNote.get(next.noteId);
      if (list) list.push(next.id);
      else this.cardsByNote.set(next.noteId, [next.id]);
    }
  }

  private onRevlogChanged(prev: Revlog | undefined, next: Revlog | undefined) {
    if (prev) {
      const list = this.revlogByCard.get(prev.cardId);
      if (list) {
        const i = list.findIndex((r) => r.id === prev.id);
        if (i >= 0) list.splice(i, 1);
      }
    }
    if (next) {
      const list = this.revlogByCard.get(next.cardId);
      if (!list) this.revlogByCard.set(next.cardId, [next]);
      else {
        list.push(next);
        list.sort((a, b) => a.id - b.id);
      }
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 150);
  }

  /** Writes pending changes to storage. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.journalDirty) {
      this.journalDirty = false;
      this.queuePut('meta', 'syncJournal', { key: 'syncJournal', value: [...this.syncJournal] });
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const puts = this.puts;
    const dels = this.dels;
    this.puts = new Map();
    this.dels = new Map();
    this.flushing = this.flushing.then(() => this.persistence.write(puts, dels));
    return this.flushing;
  }

  /** Runs `fn` as one undoable operation. */
  transact<T>(label: string, fn: () => T, opts: { undoable?: boolean; cardId?: number } = {}): T {
    const outer = this.op;
    if (outer) return fn();
    this.op = { label, before: new Map(), cardId: opts.cardId };
    try {
      const result = fn();
      if (opts.undoable !== false && this.op.before.size) {
        this.undoStack.push(this.op);
        if (this.undoStack.length > 30) this.undoStack.shift();
      }
      return result;
    } finally {
      this.op = null;
      this.emit();
    }
  }

  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  undo(): UndoEntry | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return undefined;
    for (const [store, m] of entry.before) {
      for (const [id, prev] of m) {
        if (prev === undefined) this.remove(store, id);
        else this.put(store, CLONE(prev) as { id: number });
      }
    }
    this.emit();
    return entry;
  }

  saveSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.queuePut('meta', 'settings', { key: 'settings', value: this.settings });
    this.journal('settings', 'settings');
    this.emit();
  }

  saveSyncState(patch: Partial<Collection['syncState']>) {
    this.syncState = { ...this.syncState, ...patch };
    this.queuePut('meta', 'syncState', { key: 'syncState', value: this.syncState });
  }

  saveLocalMeta(patch: Record<string, unknown>) {
    this.localMeta = { ...this.localMeta, ...patch };
    this.queuePut('meta', 'local', { key: 'local', value: this.localMeta });
  }

  /** Records for the pending journal entries, oldest first. */
  pendingChanges(limit: number): { key: string; store: string; id: string; changedAt: number; data: unknown | null }[] {
    const out = [];
    const entries = [...this.syncJournal].sort((a, b) => a[1] - b[1]).slice(0, limit);
    for (const [key, changedAt] of entries) {
      const i = key.indexOf(':');
      const store = key.slice(0, i);
      const id = key.slice(i + 1);
      let data: unknown | null;
      if (store === 'settings') data = this.settings;
      else data = this.mapFor(store as StoreName).get(Number(id)) ?? null;
      out.push({ key, store, id, changedAt, data });
    }
    return out;
  }

  /** Drops journal entries that were pushed, unless they changed again since. */
  markPushed(sent: { key: string; changedAt: number }[]) {
    for (const s of sent) if (this.syncJournal.get(s.key) === s.changedAt) this.syncJournal.delete(s.key);
    this.journalDirty = true;
    this.scheduleFlush();
  }

  /** Applies records from the sync server. Local changes that are newer win. */
  applyRemote(rows: { store: string; id: string; changedAt: number; data: unknown | null }[]): number {
    let applied = 0;
    this.applyingRemote = true;
    try {
      for (const r of rows) {
        const local = this.syncJournal.get(`${r.store}:${r.id}`);
        if (local !== undefined && local > r.changedAt) continue;
        if (local !== undefined) this.syncJournal.delete(`${r.store}:${r.id}`);
        if (r.store === 'settings') {
          if (r.data) {
            this.settings = { ...CLONE(DEFAULT_SETTINGS), ...(r.data as Partial<Settings>) };
            this.queuePut('meta', 'settings', { key: 'settings', value: this.settings });
          }
        } else if (r.data === null) {
          this.remove(r.store as StoreName, Number(r.id));
        } else {
          this.put(r.store as StoreName, r.data as { id: number });
        }
        applied++;
      }
    } finally {
      this.applyingRemote = false;
    }
    if (applied) {
      this.undoStack = [];
      this.emit();
    }
    return applied;
  }

  // ---------- time ----------

  get today(): number {
    return dayOf(this.clock(), this.settings.rolloverHour);
  }

  dayStart(day: number) {
    return dayStart(day, this.settings.rolloverHour);
  }

  /** Unburies cards buried on a previous day. */
  checkDayRollover() {
    const today = this.today;
    const toUnbury = [...this.cards.values()].filter((c) => c.buried && (c.buriedDay ?? 0) < today);
    if (!toUnbury.length) return;
    this.transact(
      'Unbury',
      () => {
        for (const c of toUnbury) this.put('cards', { ...c, buried: 0, buriedDay: undefined });
      },
      { undoable: false },
    );
  }

  // ---------- decks ----------

  deckByName(name: string): Deck | undefined {
    const lower = name.toLowerCase();
    for (const d of this.decks.values()) if (d.name.toLowerCase() === lower) return d;
    return undefined;
  }

  sortedDecks(): Deck[] {
    return [...this.decks.values()].sort((a, b) => compareDeckNames(a.name, b.name));
  }

  childDecks(deck: Deck): Deck[] {
    const prefix = deck.name + '::';
    return this.sortedDecks().filter(
      (d) => d.name.startsWith(prefix) && !d.name.slice(prefix.length).includes('::'),
    );
  }

  /** The deck and all its descendants. */
  deckAndChildren(deckId: number): Deck[] {
    const deck = this.decks.get(deckId);
    if (!deck) return [];
    const prefix = deck.name + '::';
    return this.sortedDecks().filter((d) => d.id === deckId || d.name.startsWith(prefix));
  }

  parentDecks(deck: Deck): Deck[] {
    const parts = deck.name.split('::');
    const out: Deck[] = [];
    for (let i = parts.length - 1; i > 0; i--) {
      const p = this.deckByName(parts.slice(0, i).join('::'));
      if (p) out.push(p);
    }
    return out;
  }

  /** Finds or creates a deck by full name, creating missing parents. */
  getOrCreateDeck(name: string, configId = DEFAULT_CONFIG_ID): Deck {
    const clean = name
      .split('::')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('::');
    const existing = this.deckByName(clean);
    if (existing) return existing;
    return this.transact('Add deck', () => {
      const parts = clean.split('::');
      let deck: Deck | undefined;
      for (let i = 1; i <= parts.length; i++) {
        const n = parts.slice(0, i).join('::');
        deck = this.deckByName(n);
        if (!deck) {
          deck = { id: this.newId(), name: n, configId, mod: this.clock() };
          this.put('decks', deck);
        }
      }
      return deck!;
    });
  }

  renameDeck(deckId: number, newName: string) {
    const deck = this.decks.get(deckId);
    if (!deck) return;
    const clean = newName
      .split('::')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('::');
    if (!clean || clean === deck.name) return;
    if (this.deckByName(clean)) throw new Error('A deck with that name already exists');
    this.transact('Rename deck', () => {
      const old = deck.name;
      for (const d of this.deckAndChildren(deckId)) {
        this.put('decks', { ...d, name: clean + d.name.slice(old.length), mod: this.clock() });
      }
      // Make sure parents exist.
      const parts = clean.split('::');
      for (let i = 1; i < parts.length; i++) this.getOrCreateDeck(parts.slice(0, i).join('::'));
    });
  }

  deleteDeck(deckId: number) {
    this.transact('Delete deck', () => {
      for (const d of this.deckAndChildren(deckId).reverse()) {
        if (d.dyn) this.emptyFiltered(d.id);
        const cards = [...this.cards.values()].filter((c) => c.deckId === d.id);
        this.deleteCardsAndOrphanNotes(cards.map((c) => c.id));
        if (d.id === DEFAULT_DECK_ID) continue;
        this.remove('decks', d.id);
      }
    });
  }

  setDeckCollapsed(deckId: number, collapsed: boolean) {
    const d = this.decks.get(deckId);
    if (d) this.transact('Collapse', () => this.put('decks', { ...d, collapsed }), { undoable: false });
  }

  configFor(deckId: number): DeckConfig {
    const deck = this.decks.get(deckId);
    return this.configs.get(deck?.configId ?? DEFAULT_CONFIG_ID) ?? this.configs.get(DEFAULT_CONFIG_ID)!;
  }

  configForCard(card: Card): DeckConfig {
    return this.configFor(card.odid ?? card.deckId);
  }

  saveConfig(conf: DeckConfig) {
    this.transact('Deck options', () => this.put('configs', { ...conf, mod: this.clock() }));
  }

  addConfig(name: string, base?: DeckConfig): DeckConfig {
    const conf: DeckConfig = {
      ...CLONE(base ?? { ...DEFAULT_CONFIG, id: 0, name: '', mod: 0 }),
      id: this.newId(),
      name,
      mod: this.clock(),
    };
    this.transact('Add preset', () => this.put('configs', conf));
    return conf;
  }

  removeConfig(configId: number) {
    if (configId === DEFAULT_CONFIG_ID) return;
    this.transact('Remove preset', () => {
      for (const d of this.decks.values()) {
        if (d.configId === configId) this.put('decks', { ...d, configId: DEFAULT_CONFIG_ID });
      }
      this.remove('configs', configId);
    });
  }

  setDeckConfig(deckId: number, configId: number, includeChildren = false) {
    this.transact('Set preset', () => {
      const targets = includeChildren ? this.deckAndChildren(deckId) : [this.decks.get(deckId)!];
      for (const d of targets) if (!d.dyn) this.put('decks', { ...d, configId });
    });
  }

  saveDeck(deck: Deck) {
    this.transact('Edit deck', () => this.put('decks', { ...deck, mod: this.clock() }));
  }

  private deckToday(deck: Deck) {
    const today = this.today;
    if (deck.today?.day === today) return deck.today;
    return { day: today, newDone: 0, revDone: 0, newExtra: 0, revExtra: 0 };
  }

  /** Custom study: extend today's limits for a deck. */
  extendLimits(deckId: number, extraNew: number, extraRev: number) {
    const deck = this.decks.get(deckId);
    if (!deck) return;
    this.transact('Custom study', () => {
      const t = this.deckToday(deck);
      this.put('decks', {
        ...deck,
        today: { ...t, newExtra: t.newExtra + extraNew, revExtra: t.revExtra + extraRev },
      });
    });
  }

  // ---------- queues & counts ----------

  private deckCardIndex(): Map<number, Card[]> {
    if (this.cardsByDeck) return this.cardsByDeck;
    const m = new Map<number, Card[]>();
    for (const c of this.cards.values()) {
      const list = m.get(c.deckId);
      if (list) list.push(c);
      else m.set(c.deckId, [c]);
    }
    this.cardsByDeck = m;
    return m;
  }

  private gather(deck: Deck, memo: Map<number, Gathered>, session?: StudySession): Gathered {
    const cached = memo.get(deck.id);
    if (cached) return cached;
    const today = this.today;
    const now = this.clock();
    const dayEnd = this.dayStart(today + 1);
    const conf = this.configFor(deck.id);
    const own = this.deckCardIndex().get(deck.id) ?? [];
    let news: Card[] = [];
    let reviews: Card[] = [];
    let learn: Card[] = [];

    if (deck.dyn && !deck.dyn.reschedule) {
      // Preview deck: every card is shown once; "again" holds it back briefly.
      for (const c of own) {
        if (c.suspended || c.buried) continue;
        const hold = session?.previewHold.get(c.id);
        if (hold !== undefined) learn.push({ ...c, due: hold });
        else if (c.state === CardState.New) news.push(c);
        else reviews.push(c);
      }
      learn.sort((a, b) => a.due - b.due);
      const r = { news, reviews, learn };
      memo.set(deck.id, r);
      return r;
    }

    for (const c of own) {
      if (c.suspended || c.buried) continue;
      if (c.state === CardState.New) news.push(c);
      else if (c.state === CardState.Review) {
        if (c.due <= today || (deck.dyn && c.odid !== undefined)) reviews.push(c);
      } else if (c.due < dayEnd) learn.push(c);
    }
    const hash = (id: number) => ((Math.imul(id | 0, 2654435761) ^ today) >>> 0) % 1000003;
    if (conf.newOrder === 'random' && !deck.dyn) news.sort((a, b) => hash(a.id) - hash(b.id));
    else if (!deck.dyn) news.sort((a, b) => a.due - b.due || a.ord - b.ord);

    for (const child of this.childDecks(deck)) {
      const g = this.gather(child, memo, session);
      news = news.concat(g.news);
      reviews = reviews.concat(g.reviews);
      learn = learn.concat(g.learn);
    }
    if (!deck.dyn) {
      // Shuffles are keyed by card id and day, so the order is stable within a day.
      if (conf.newGather === 'random') news.sort((a, b) => hash(a.id) - hash(b.id));
      if (conf.reviewSort === 'random') reviews.sort((a, b) => hash(a.id) - hash(b.id));
      else reviews.sort((a, b) => a.due - b.due || hash(a.id) - hash(b.id));
    }
    learn.sort((a, b) => a.due - b.due);

    if (!deck.dyn) {
      const t = this.deckToday(deck);
      const revLeft = Math.max(0, conf.revPerDay - t.revDone + t.revExtra);
      reviews = reviews.slice(0, revLeft);
      let newLeft = Math.max(0, conf.newPerDay - t.newDone + t.newExtra);
      if (!this.settings.newIgnoresReviewLimit) newLeft = Math.min(newLeft, Math.max(0, revLeft - reviews.length));
      news = news.slice(0, newLeft);
    }
    void now;
    const r = { news, reviews, learn };
    memo.set(deck.id, r);
    return r;
  }

  counts(deckId: number, session?: StudySession): Counts {
    const deck = this.decks.get(deckId);
    if (!deck) return { new: 0, learn: 0, review: 0 };
    const g = this.gather(deck, new Map(), session);
    return { new: g.news.length, learn: g.learn.length, review: g.reviews.length };
  }

  deckTree(): DeckNode[] {
    const memo = new Map<number, Gathered>();
    const totals = new Map<number, number>();
    for (const c of this.cards.values()) totals.set(c.deckId, (totals.get(c.deckId) ?? 0) + 1);
    const build = (deck: Deck, depth: number): DeckNode => {
      const g = this.gather(deck, memo);
      const children = this.childDecks(deck).map((d) => build(d, depth + 1));
      return {
        deck,
        label: deck.name.split('::').pop()!,
        depth,
        children,
        counts: { new: g.news.length, learn: g.learn.length, review: g.reviews.length },
        total: (totals.get(deck.id) ?? 0) + children.reduce((s, c) => s + c.total, 0),
      };
    };
    const roots = this.sortedDecks().filter((d) => !d.name.includes('::'));
    const tree = roots.map((d) => build(d, 0));
    // Hide the empty Default deck once other decks exist, as Anki does.
    return tree.filter((n) => !(n.deck.id === DEFAULT_DECK_ID && n.total === 0 && tree.length > 1));
  }

  startSession(deckId: number): StudySession {
    this.checkDayRollover();
    this.saveSettings({ currentDeckId: deckId });
    return { deckId, answered: 0, sinceNew: 0, previewHold: new Map(), startedAt: this.clock() };
  }

  nextCard(session: StudySession): NextCard {
    const deck = this.decks.get(session.deckId);
    if (!deck) return { kind: 'done' };
    const now = this.clock();
    const { news, reviews, learn } = this.gather(deck, new Map(), session);
    const notLast = (list: Card[]) =>
      list.length > 1 && list[0].id === session.lastCardId ? list[1] : list[0];

    const dueLearn = learn.filter((c) => c.due <= now);
    if (dueLearn.length) return { kind: 'card', card: this.cards.get(notLast(dueLearn).id)!, queue: 'learn' };

    const conf = this.configFor(deck.id);
    if (news.length || reviews.length) {
      let pickNew: boolean;
      if (!reviews.length) pickNew = true;
      else if (!news.length) pickNew = false;
      else if (conf.newMix === 'before') pickNew = true;
      else if (conf.newMix === 'after') pickNew = false;
      else {
        const every = (reviews.length + news.length) / news.length;
        pickNew = session.sinceNew + 1 >= every;
      }
      const card = pickNew ? news[0] : reviews[0];
      return { kind: 'card', card: this.cards.get(card.id)!, queue: pickNew ? 'new' : 'review' };
    }

    const ahead = learn.filter((c) => c.due <= now + this.settings.learnAheadMins * 60_000);
    if (ahead.length) return { kind: 'card', card: this.cards.get(notLast(ahead).id)!, queue: 'learn' };
    if (learn.length) return { kind: 'wait', until: learn[0].due };
    return { kind: 'done' };
  }

  schedContext(card: Card): SchedContext {
    return {
      now: this.clock(),
      today: this.today,
      rolloverHour: this.settings.rolloverHour,
      conf: this.configForCard(card),
      scheduler: this.settings.scheduler,
      fuzz: this.settings.fuzz,
    };
  }

  isPreviewCard(card: Card): boolean {
    const d = this.decks.get(card.deckId);
    return !!d?.dyn && !d.dyn.reschedule;
  }

  /** What each rating would do; null for preview-mode cards. */
  previews(card: Card): Record<Rating, Outcome> | null {
    if (this.isPreviewCard(card)) return null;
    return nextStates(card, this.schedContext(card));
  }

  answer(cardId: number, rating: Rating, timeMs: number, session?: StudySession) {
    const card = this.cards.get(cardId);
    if (!card) return;
    this.transact(
      'Answer',
      () => {
        const now = this.clock();
        const today = this.today;
        const deck = this.decks.get(card.deckId);
        if (session) {
          session.answered++;
          session.sinceNew = card.state === CardState.New ? 0 : session.sinceNew + 1;
          session.lastCardId = card.id;
        }
        if (deck?.dyn && !deck.dyn.reschedule) {
          this.addRevlog({
            cardId,
            ease: rating,
            ivl: 0,
            lastIvl: card.ivl,
            factor: Math.round(card.ease * 1000),
            time: timeMs,
            type: RevlogType.Filtered,
          });
          if (rating === 1) session?.previewHold.set(card.id, now + 60_000);
          else {
            session?.previewHold.delete(card.id);
            this.put('cards', this.returnHome({ ...card, mod: now }));
          }
          return;
        }

        const outcome = nextStates(card, this.schedContext(card))[rating];
        let next = outcome.card;
        if (next.odid !== undefined) {
          next.odue = undefined;
          if (next.state === CardState.Review) next = this.returnHome(next);
        }
        const early =
          card.state === CardState.Review && card.due > today && !!deck?.dyn;
        this.addRevlog({
          cardId,
          ease: rating,
          ivl: outcome.revlogIvl,
          lastIvl: outcome.lastIvl,
          factor: Math.round((next.ease || 0) * 1000),
          time: timeMs,
          type: early ? RevlogType.Filtered : outcome.revlogType,
          stability: next.stability,
          difficulty: next.difficulty,
        });
        if (outcome.leech) {
          const note = this.notes.get(card.noteId);
          if (note && !note.tags.some((t) => t.toLowerCase() === 'leech')) {
            this.put('notes', { ...note, tags: [...note.tags, 'leech'], mod: now });
          }
          if (this.configForCard(card).leechAction === 'suspend') next.suspended = true;
        }
        this.put('cards', next);

        // Daily counters on the deck and its parents.
        const counted = this.decks.get(card.odid ?? card.deckId);
        if (counted && (card.state === CardState.New || card.state === CardState.Review)) {
          for (const d of [counted, ...this.parentDecks(counted)]) {
            const t = this.deckToday(d);
            const nt = { ...t };
            if (card.state === CardState.New) nt.newDone++;
            else nt.revDone++;
            this.put('decks', { ...d, today: nt });
          }
        }
        this.burySiblings(card);
      },
      { cardId },
    );
  }

  private burySiblings(card: Card) {
    const conf = this.configForCard(card);
    if (!conf.buryNew && !conf.buryReview && !conf.buryInterday) return;
    const today = this.today;
    const dayEnd = this.dayStart(today + 1);
    for (const sid of this.cardsByNote.get(card.noteId) ?? []) {
      if (sid === card.id) continue;
      const s = this.cards.get(sid)!;
      if (s.suspended || s.buried) continue;
      const bury =
        (s.state === CardState.New && conf.buryNew) ||
        (s.state === CardState.Review && s.due <= today && conf.buryReview) ||
        ((s.state === CardState.Learning || s.state === CardState.Relearning) &&
          s.due >= this.dayStart(today) &&
          s.due < dayEnd &&
          s.due === this.dayStart(dayOf(s.due, this.settings.rolloverHour)) &&
          conf.buryInterday);
      if (bury) this.put('cards', { ...s, buried: 1, buriedDay: today });
    }
  }

  private returnHome(c: Card): Card {
    if (c.odid === undefined) return c;
    const next = { ...c, deckId: c.odid };
    if (c.odue !== undefined) next.due = c.odue;
    delete next.odid;
    delete next.odue;
    return next;
  }

  private addRevlog(r: Omit<Revlog, 'id'>) {
    this.put('revlog', { ...r, id: this.newId() });
  }

  // ---------- card actions ----------

  private cardOp(label: string, ids: number[], fn: (c: Card) => Card | null) {
    this.transact(label, () => {
      for (const id of ids) {
        const c = this.cards.get(id);
        if (!c) continue;
        const next = fn({ ...c });
        if (next) this.put('cards', { ...next, mod: this.clock() });
      }
    });
  }

  siblings(cardId: number): number[] {
    const c = this.cards.get(cardId);
    return c ? [...(this.cardsByNote.get(c.noteId) ?? [])] : [];
  }

  cardsOfNote(noteId: number): Card[] {
    return (this.cardsByNote.get(noteId) ?? []).map((id) => this.cards.get(id)!).filter(Boolean);
  }

  bury(ids: number[]) {
    const today = this.today;
    this.cardOp('Bury', ids, (c) => ({ ...c, buried: 2, buriedDay: today }));
  }

  unbury(ids: number[]) {
    this.cardOp('Unbury', ids, (c) => ({ ...c, buried: 0, buriedDay: undefined }));
  }

  unburyDeck(deckId: number) {
    const deckIds = new Set(this.deckAndChildren(deckId).map((d) => d.id));
    this.unbury([...this.cards.values()].filter((c) => c.buried && deckIds.has(c.deckId)).map((c) => c.id));
  }

  setSuspended(ids: number[], suspended: boolean) {
    this.cardOp(suspended ? 'Suspend' : 'Unsuspend', ids, (c) => ({ ...c, suspended }));
  }

  setFlag(ids: number[], flag: number) {
    this.cardOp('Flag', ids, (c) => ({ ...c, flag }));
  }

  setDeck(ids: number[], deckId: number) {
    this.cardOp('Change deck', ids, (c) => (c.odid !== undefined ? { ...c, odid: deckId } : { ...c, deckId }));
  }

  /** Resets cards to new, placed at the end of the new queue. */
  forget(ids: number[], resetCounts = true) {
    this.transact('Forget', () => {
      let pos = this.nextNewPosition();
      for (const id of ids) {
        const c = this.cards.get(id);
        if (!c) continue;
        const home = this.returnHome(c);
        this.put('cards', {
          ...home,
          state: CardState.New,
          due: pos++,
          ivl: 0,
          ease: 0,
          step: 0,
          stability: undefined,
          difficulty: undefined,
          lastReview: undefined,
          reps: resetCounts ? 0 : c.reps,
          lapses: resetCounts ? 0 : c.lapses,
          mod: this.clock(),
        });
        this.addRevlog({ cardId: id, ease: 0, ivl: 0, lastIvl: c.ivl, factor: 0, time: 0, type: RevlogType.Manual });
      }
    });
  }

  /** Sets the due date to `days` from today (review cards keep/adjust their interval). */
  setDueDate(ids: number[], days: number, changeIvl = false) {
    const today = this.today;
    this.transact('Set due date', () => {
      for (const id of ids) {
        const c = this.cards.get(id);
        if (!c) continue;
        const ivl = changeIvl || c.state !== CardState.Review ? Math.max(1, days) : c.ivl;
        this.put('cards', {
          ...this.returnHome(c),
          state: CardState.Review,
          due: today + days,
          ivl,
          ease: c.ease || this.configForCard(c).startingEase,
          step: 0,
          mod: this.clock(),
        });
        this.addRevlog({ cardId: id, ease: 0, ivl, lastIvl: c.ivl, factor: Math.round((c.ease || 2.5) * 1000), time: 0, type: RevlogType.Manual });
      }
    });
  }

  repositionNew(ids: number[], start: number, step = 1, shift = false) {
    this.transact('Reposition', () => {
      const cards = ids.map((id) => this.cards.get(id)!).filter((c) => c && c.state === CardState.New);
      if (shift) {
        const span = cards.length * step;
        for (const c of this.cards.values()) {
          if (c.state === CardState.New && c.due >= start && !ids.includes(c.id)) {
            this.put('cards', { ...c, due: c.due + span });
          }
        }
      }
      cards.sort((a, b) => a.due - b.due).forEach((c, i) => this.put('cards', { ...c, due: start + i * step }));
    });
  }

  nextNewPosition(): number {
    let max = 0;
    for (const c of this.cards.values()) if (c.state === CardState.New && c.due > max) max = c.due;
    return max + 1;
  }

  deleteCardsAndOrphanNotes(cardIds: number[]) {
    this.transact('Delete', () => {
      const notes = new Set<number>();
      for (const id of cardIds) {
        const c = this.cards.get(id);
        if (!c) continue;
        notes.add(c.noteId);
        this.remove('cards', id);
        for (const r of [...(this.revlogByCard.get(id) ?? [])]) this.remove('revlog', r.id);
      }
      for (const nid of notes) if (!(this.cardsByNote.get(nid)?.length)) this.remove('notes', nid);
    });
  }

  deleteNotes(noteIds: number[]) {
    this.transact('Delete notes', () => {
      const cardIds = noteIds.flatMap((n) => this.cardsByNote.get(n) ?? []);
      this.deleteCardsAndOrphanNotes(cardIds);
      for (const n of noteIds) this.remove('notes', n);
    });
  }

  // ---------- notes ----------

  hasTag(noteId: number, tag: string) {
    return !!this.notes.get(noteId)?.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
  }

  toggleMark(noteId: number) {
    const note = this.notes.get(noteId);
    if (!note) return;
    const marked = this.hasTag(noteId, 'marked');
    const tags = marked ? note.tags.filter((t) => t.toLowerCase() !== 'marked') : [...note.tags, 'marked'];
    this.transact(marked ? 'Unmark' : 'Mark', () => this.put('notes', { ...note, tags, mod: this.clock() }));
  }

  addNote(notetypeId: number, fields: string[], tags: string[], deckId: number, guid?: string): Note {
    const nt = this.notetypes.get(notetypeId);
    if (!nt) throw new Error('Unknown note type');
    const ords = cardOrdinals(nt, fields);
    if (!ords.length) {
      throw new Error(
        nt.kind === 'cloze'
          ? 'Cloze notes need at least one deletion like {{c1::text}}'
          : 'The first field is empty, so no cards would be generated',
      );
    }
    return this.transact('Add note', () => {
      const now = this.clock();
      const note: Note = {
        id: this.newId(),
        guid: guid ?? randomGuid(),
        notetypeId,
        fields: [...fields],
        tags: normalizeTags(tags),
        mod: now,
      };
      this.put('notes', note);
      const pos = this.nextNewPosition();
      for (const ord of ords) this.put('cards', this.newCard(note.id, deckId, ord, pos));
      return note;
    });
  }

  newCard(noteId: number, deckId: number, ord: number, pos: number): Card {
    return {
      id: this.newId(),
      noteId,
      deckId,
      ord,
      state: CardState.New,
      due: pos,
      ivl: 0,
      ease: 0,
      reps: 0,
      lapses: 0,
      step: 0,
      suspended: false,
      buried: 0,
      flag: 0,
      mod: this.clock(),
    };
  }

  /** Saves edited fields/tags and generates any newly required cards. */
  updateNote(note: Note, deckIdForNewCards?: number) {
    this.transact('Edit note', () => {
      const clean = { ...note, tags: normalizeTags(note.tags), mod: this.clock() };
      this.put('notes', clean);
      this.generateMissingCards(clean, deckIdForNewCards);
    });
  }

  private generateMissingCards(note: Note, deckId?: number) {
    const nt = this.notetypes.get(note.notetypeId);
    if (!nt) return;
    const existing = this.cardsOfNote(note.id);
    const have = new Set(existing.map((c) => c.ord));
    const target = deckId ?? existing[0]?.odid ?? existing[0]?.deckId ?? DEFAULT_DECK_ID;
    let pos = 0;
    for (const ord of cardOrdinals(nt, note.fields)) {
      if (have.has(ord)) continue;
      if (!pos) pos = this.nextNewPosition();
      this.put('cards', this.newCard(note.id, target, ord, pos));
    }
  }

  /** Changes a note's type, mapping fields by index map (new field i <- old field map[i]). */
  changeNotetype(noteIds: number[], newNtId: number, fieldMap: (number | null)[]) {
    this.transact('Change note type', () => {
      for (const nid of noteIds) {
        const note = this.notes.get(nid);
        if (!note) continue;
        const fields = fieldMap.map((src) => (src === null ? '' : note.fields[src] ?? ''));
        this.put('notes', { ...note, notetypeId: newNtId, fields, mod: this.clock() });
        const nt = this.notetypes.get(newNtId)!;
        const valid = new Set(cardOrdinals(nt, fields));
        for (const c of this.cardsOfNote(nid)) if (!valid.has(c.ord)) this.remove('cards', c.id);
        this.generateMissingCards(this.notes.get(nid)!);
      }
    });
  }

  saveNotetype(nt: Notetype) {
    this.transact('Edit note type', () => this.put('notetypes', { ...nt, mod: this.clock() }));
  }

  putNotetype(nt: Notetype) {
    this.put('notetypes', nt);
  }

  // ---------- tags ----------

  allTags(): Map<string, number> {
    const counts = new Map<string, number>();
    const canon = new Map<string, string>();
    for (const n of this.notes.values()) {
      for (const t of n.tags) {
        const k = t.toLowerCase();
        if (!canon.has(k)) canon.set(k, t);
        const name = canon.get(k)!;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return new Map([...counts].sort((a, b) => a[0].localeCompare(b[0])));
  }

  addTags(noteIds: number[], tags: string[]) {
    this.transact('Add tags', () => {
      for (const id of noteIds) {
        const n = this.notes.get(id);
        if (n) this.put('notes', { ...n, tags: normalizeTags([...n.tags, ...tags]), mod: this.clock() });
      }
    });
  }

  removeTags(noteIds: number[], tags: string[]) {
    const drop = new Set(tags.map((t) => t.toLowerCase()));
    this.transact('Remove tags', () => {
      for (const id of noteIds) {
        const n = this.notes.get(id);
        if (n) this.put('notes', { ...n, tags: n.tags.filter((t) => !drop.has(t.toLowerCase())), mod: this.clock() });
      }
    });
  }

  /** Renames a tag and its children (`old::*`). */
  renameTag(oldName: string, newName: string) {
    const o = oldName.toLowerCase();
    const clean = newName.trim().replace(/\s+/g, '_');
    this.transact('Rename tag', () => {
      for (const n of this.notes.values()) {
        let changed = false;
        const tags = n.tags.map((t) => {
          const l = t.toLowerCase();
          if (l === o) return (changed = true), clean;
          if (l.startsWith(o + '::')) return (changed = true), clean + t.slice(oldName.length);
          return t;
        });
        if (changed) this.put('notes', { ...n, tags: normalizeTags(tags), mod: this.clock() });
      }
    });
  }

  deleteTag(name: string) {
    const o = name.toLowerCase();
    this.transact('Delete tag', () => {
      for (const n of this.notes.values()) {
        const tags = n.tags.filter((t) => {
          const l = t.toLowerCase();
          return l !== o && !l.startsWith(o + '::');
        });
        if (tags.length !== n.tags.length) this.put('notes', { ...n, tags, mod: this.clock() });
      }
    });
  }

  // ---------- search ----------

  searchEnv(): SearchEnv {
    const rollover = this.settings.rolloverHour;
    return {
      now: this.clock(),
      today: this.today,
      rolloverHour: rollover,
      decks: [...this.decks.values()],
      currentDeckId: this.settings.currentDeckId,
      note: (id) => this.notes.get(id),
      notetype: (id) => this.notetypes.get(id),
      revlog: (id) => this.revlogByCard.get(id) ?? [],
      retrievability: (c) => this.retrievability(c),
      dueDay: (c) => this.dueDay(c),
    };
  }

  search(query: string): Card[] {
    const q = query.trim();
    if (!q) return [...this.cards.values()];
    const pred = compileSearch(q, this.searchEnv());
    return [...this.cards.values()].filter(pred);
  }

  revlogFor(cardId: number): Revlog[] {
    return this.revlogByCard.get(cardId) ?? [];
  }

  dueDay(c: Card): number | undefined {
    if (c.state === CardState.New) return undefined;
    if (c.state === CardState.Review) return c.due;
    return dayOf(c.due, this.settings.rolloverHour);
  }

  retrievability(c: Card): number | undefined {
    if (c.state === CardState.New) return undefined;
    const conf = this.configForCard(c);
    const w = normalizeWeights(conf.fsrsParams);
    const mem = currentMemory(c, w, conf.desiredRetention);
    if (!mem) return undefined;
    const elapsed = elapsedDays(c, { today: this.today, rolloverHour: this.settings.rolloverHour });
    return retrievability(w, elapsed, mem.stability);
  }

  // ---------- filtered decks ----------

  createFiltered(name: string, spec: FilteredSpec): Deck {
    let finalName = name;
    for (let i = 2; this.deckByName(finalName); i++) finalName = `${name} ${i}`;
    const deck: Deck = { id: this.newId(), name: finalName, configId: DEFAULT_CONFIG_ID, dyn: spec, mod: this.clock() };
    this.transact('Create filtered deck', () => {
      this.put('decks', deck);
      this.rebuildFiltered(deck.id);
    });
    return this.decks.get(deck.id)!;
  }

  rebuildFiltered(deckId: number): number {
    const deck = this.decks.get(deckId);
    if (!deck?.dyn) return 0;
    const spec = deck.dyn;
    return this.transact('Rebuild filtered deck', () => {
      this.emptyFiltered(deckId);
      const pred = spec.search.trim() ? compileSearch(spec.search, this.searchEnv()) : () => true;
      let cards = [...this.cards.values()].filter(
        (c) => !c.suspended && !c.buried && c.odid === undefined && !this.decks.get(c.deckId)?.dyn && pred(c),
      );
      cards = this.sortForFiltered(cards, spec.order).slice(0, spec.limit);
      for (const c of cards) this.put('cards', { ...c, odid: c.deckId, odue: c.due, deckId });
      return cards.length;
    });
  }

  private sortForFiltered(cards: Card[], order: FilteredSpec['order']): Card[] {
    const key: Record<FilteredSpec['order'], (c: Card) => number> = {
      random: () => Math.random(),
      due: (c) => (c.state === CardState.New ? 1e12 + c.due : (this.dueDay(c) ?? 0)),
      added: (c) => c.noteId,
      ivlAsc: (c) => c.ivl,
      ivlDesc: (c) => -c.ivl,
      lapses: (c) => -c.lapses,
      retrievability: (c) => this.retrievability(c) ?? 2,
    };
    const k = key[order];
    const decorated = cards.map((c) => [k(c), c] as const);
    decorated.sort((a, b) => a[0] - b[0]);
    return decorated.map((d) => d[1]);
  }

  emptyFiltered(deckId: number) {
    this.transact('Empty filtered deck', () => {
      for (const c of [...this.cards.values()]) if (c.deckId === deckId) this.put('cards', this.returnHome(c));
    });
  }

  // ---------- bulk import ----------

  /** Runs a bulk mutation without recording undo history. */
  bulk<T>(label: string, fn: (api: BulkApi) => T, opts: { lowPriority?: boolean } = {}): T {
    const api: BulkApi = {
      putCard: (c) => this.put('cards', c),
      putNote: (n) => this.put('notes', n),
      putNotetype: (n) => this.put('notetypes', n),
      putDeck: (d) => this.put('decks', d),
      putConfig: (c) => this.put('configs', c),
      putRevlog: (r) => this.put('revlog', r),
      removeCard: (id) => this.remove('cards', id),
      newId: () => this.newId(),
    };
    if (opts.lowPriority) this.journalAt = 1;
    try {
      const result = this.transact(label, () => fn(api), { undoable: false });
      this.undoStack = [];
      return result;
    } finally {
      this.journalAt = undefined;
    }
  }

  noteByGuid(guid: string): Note | undefined {
    for (const n of this.notes.values()) if (n.guid === guid) return n;
    return undefined;
  }

  async putMedia(name: string, data: Blob) {
    const p = this.persistence as unknown as { putMedia?: (n: string, d: Blob) => Promise<void> };
    this.mediaNames.add(name);
    this.queuePut('media', name, { name, data });
    void p;
  }

  async getMedia(name: string): Promise<Blob | undefined> {
    const p = this.persistence as unknown as { getMedia?: (n: string) => Promise<Blob | undefined> };
    await this.flush();
    return p.getMedia?.(name);
  }

  async wipe() {
    await this.flush();
    await this.persistence.clear();
    this.undoStack = [];
    await this.load();
  }
}

export interface BulkApi {
  putCard(c: Card): void;
  putNote(n: Note): void;
  putNotetype(n: Notetype): void;
  putDeck(d: Deck): void;
  putConfig(c: DeckConfig): void;
  putRevlog(r: Revlog): void;
  removeCard(id: number): void;
  newId(): number;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags.flatMap((t) => t.split(/\s+/))) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function randomGuid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

/** Sorts deck names component-wise so children follow their parent. */
export function compareDeckNames(a: string, b: string): number {
  const pa = a.split('::');
  const pb = b.split('::');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = pa[i].localeCompare(pb[i], undefined, { numeric: true, sensitivity: 'base' });
    if (c) return c;
  }
  return pa.length - pb.length;
}
