import { describe, expect, it } from 'vitest';
import { Collection } from '../src/core/collection';
import { MemoryPersistence } from '../src/core/db';
import { NT_BASIC, NT_REVERSED } from '../src/core/notetypes';
import { CardState } from '../src/core/types';

const T0 = new Date(2026, 9, 29, 12, 0, 0).getTime();

async function make(nNotes = 30) {
  const col = new Collection(new MemoryPersistence());
  let now = T0;
  col.clock = () => now;
  await col.load();
  const deck = col.getOrCreateDeck('Lang::Words');
  for (let i = 0; i < nNotes; i++) col.addNote(NT_BASIC, [`q${i}`, `a${i}`], [], deck.id);
  const parent = col.deckByName('Lang')!;
  return { col, deck, parent, advance: (ms: number) => (now += ms) };
}

describe('queues and daily limits', () => {
  it('caps new cards by the preset limit and counts answers against parents', async () => {
    const { col, deck, parent } = await make();
    expect(col.counts(deck.id).new).toBe(20);
    expect(col.counts(parent.id).new).toBe(20);
    const s = col.startSession(parent.id);
    for (let i = 0; i < 5; i++) {
      const n = col.nextCard(s);
      expect(n.kind).toBe('card');
      if (n.kind === 'card') col.answer(n.card.id, 4, 1000, s);
    }
    expect(col.counts(parent.id).new).toBe(15);
    expect(col.counts(deck.id).new).toBe(15);
  });

  it('new cards are shown in position order and learning cards come back when due', async () => {
    const { col, deck, advance } = await make(3);
    const s = col.startSession(deck.id);
    const first = col.nextCard(s);
    if (first.kind !== 'card') throw new Error('expected card');
    expect(col.notes.get(first.card.noteId)!.fields[0]).toBe('q0');
    col.answer(first.card.id, 1, 1000, s); // Again -> 1m step
    expect(col.counts(deck.id)).toEqual({ new: 2, learn: 1, review: 0 });
    // Remaining new cards come before the not-yet-due learning card...
    const n2 = col.nextCard(s);
    expect(n2.kind === 'card' && n2.queue).toBe('new');
    // ...and once due, the learning card takes priority.
    advance(61_000);
    const n3 = col.nextCard(s);
    expect(n3.kind === 'card' && n3.card.id).toBe(first.card.id);
  });

  it('finishes with learn-ahead and then reports done', async () => {
    const { col, deck } = await make(1);
    const s = col.startSession(deck.id);
    let n = col.nextCard(s);
    if (n.kind !== 'card') throw new Error();
    col.answer(n.card.id, 3, 1000, s); // -> 10m step, within the 20m learn-ahead
    n = col.nextCard(s);
    expect(n.kind === 'card' && n.queue).toBe('learn');
    if (n.kind === 'card') col.answer(n.card.id, 3, 1000, s);
    expect(col.cards.get(n.kind === 'card' ? n.card.id : 0)?.state).toBe(CardState.Review);
    expect(col.nextCard(s).kind).toBe('done');
  });

  it('review cards become due on the right day', async () => {
    const { col, deck, advance } = await make(1);
    const s = col.startSession(deck.id);
    const n = col.nextCard(s);
    if (n.kind !== 'card') throw new Error();
    col.answer(n.card.id, 4, 1000, s);
    const ivl = col.cards.get(n.card.id)!.ivl;
    expect(col.counts(deck.id).review).toBe(0);
    advance((ivl - 1) * 86_400_000);
    expect(col.counts(deck.id).review).toBe(0);
    advance(86_400_000);
    expect(col.counts(deck.id).review).toBe(1);
  });
});

describe('siblings, undo, leeches, filtered decks', () => {
  it('buries siblings when enabled and unburies at rollover', async () => {
    const { col, deck, advance } = await make(0);
    col.saveConfig({ ...col.configFor(deck.id), buryNew: true });
    const note = col.addNote(NT_REVERSED, ['front', 'back'], [], deck.id);
    const [c1, c2] = col.cardsOfNote(note.id);
    col.answer(c1.id, 3, 1000);
    expect(col.cards.get(c2.id)!.buried).toBe(1);
    expect(col.counts(deck.id).new).toBe(0);
    advance(86_400_000);
    col.checkDayRollover();
    expect(col.cards.get(c2.id)!.buried).toBe(0);
  });

  it('undo restores the card, revlog and daily counters', async () => {
    const { col, deck } = await make(2);
    const s = col.startSession(deck.id);
    const n = col.nextCard(s);
    if (n.kind !== 'card') throw new Error();
    const before = structuredClone(col.cards.get(n.card.id));
    col.answer(n.card.id, 3, 1000, s);
    expect(col.revlog.size).toBe(1);
    const entry = col.undo();
    expect(entry?.cardId).toBe(n.card.id);
    expect(col.cards.get(n.card.id)).toEqual(before);
    expect(col.revlog.size).toBe(0);
    expect(col.counts(deck.id).new).toBe(2);
  });

  it('tags and suspends leeches', async () => {
    const { col, deck, advance } = await make(1);
    col.saveConfig({ ...col.configFor(deck.id), leechThreshold: 2, leechAction: 'suspend', relearnSteps: [] });
    const card = [...col.cards.values()][0];
    col.answer(card.id, 4, 1000);
    for (let i = 0; i < 2; i++) {
      advance(30 * 86_400_000);
      col.answer(card.id, 1, 1000);
    }
    const c = col.cards.get(card.id)!;
    expect(c.lapses).toBe(2);
    expect(c.suspended).toBe(true);
    expect(col.hasTag(c.noteId, 'leech')).toBe(true);
  });

  it('filtered decks borrow cards and return them', async () => {
    const { col, deck } = await make(5);
    const f = col.createFiltered('Cram', { search: 'q1 or q2', limit: 10, order: 'added', reschedule: true });
    const inF = [...col.cards.values()].filter((c) => c.deckId === f.id);
    expect(inF).toHaveLength(2);
    expect(inF.every((c) => c.odid === deck.id)).toBe(true);
    // Graduating returns the card home.
    col.answer(inF[0].id, 4, 1000);
    expect(col.cards.get(inF[0].id)!.deckId).toBe(deck.id);
    col.emptyFiltered(f.id);
    expect(col.cards.get(inF[1].id)!.deckId).toBe(deck.id);
    expect(col.cards.get(inF[1].id)!.state).toBe(CardState.New);
  });

  it('preview filtered decks do not reschedule', async () => {
    const { col } = await make(2);
    const f = col.createFiltered('Preview', { search: 'q0', limit: 10, order: 'added', reschedule: false });
    const s = col.startSession(f.id);
    const n = col.nextCard(s);
    if (n.kind !== 'card') throw new Error();
    col.answer(n.card.id, 3, 1000, s);
    const c = col.cards.get(n.card.id)!;
    expect(c.state).toBe(CardState.New);
    expect(c.odid).toBeUndefined();
    expect(col.nextCard(s).kind).toBe('done');
  });

  it('renaming a deck renames its children; tags rename hierarchically', async () => {
    const { col, parent } = await make(1);
    col.renameDeck(parent.id, 'Languages');
    expect(col.deckByName('Languages::Words')).toBeDefined();
    const note = [...col.notes.values()][0];
    col.addTags([note.id], ['topic::sub']);
    col.renameTag('topic', 'subject');
    expect(col.notes.get(note.id)!.tags).toContain('subject::sub');
  });
});
