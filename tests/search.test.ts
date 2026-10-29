import { describe, expect, it } from 'vitest';
import { parseSearch, SearchError } from '../src/core/search';
import { Collection } from '../src/core/collection';
import { MemoryPersistence } from '../src/core/db';
import { NT_BASIC, NT_CLOZE } from '../src/core/notetypes';
import { CardState } from '../src/core/types';

describe('parser', () => {
  it('implicit and, or, negation, groups', () => {
    expect(parseSearch('dog cat')).toEqual({
      type: 'and',
      children: [
        { type: 'term', key: '', value: 'dog' },
        { type: 'term', key: '', value: 'cat' },
      ],
    });
    expect(parseSearch('dog or cat')).toEqual({
      type: 'or',
      children: [
        { type: 'term', key: '', value: 'dog' },
        { type: 'term', key: '', value: 'cat' },
      ],
    });
    expect(parseSearch('-(a OR b) c')).toEqual({
      type: 'and',
      children: [
        {
          type: 'not',
          child: {
            type: 'or',
            children: [
              { type: 'term', key: '', value: 'a' },
              { type: 'term', key: '', value: 'b' },
            ],
          },
        },
        { type: 'term', key: '', value: 'c' },
      ],
    });
  });

  it('quoted values and fields', () => {
    expect(parseSearch('"a dog"')).toEqual({ type: 'term', key: '', value: 'a dog' });
    expect(parseSearch('deck:"My Deck::Sub"')).toEqual({ type: 'term', key: 'deck', value: 'My Deck::Sub' });
    expect(parseSearch('"deck:a b"')).toEqual({ type: 'term', key: 'deck', value: 'a b' });
    expect(parseSearch('Deck:x')).toEqual({ type: 'term', key: 'deck', value: 'x' });
  });

  it('or binds looser than and', () => {
    const n = parseSearch('a b or c');
    expect(n.type).toBe('or');
  });

  it('reports errors', () => {
    expect(() => parseSearch('(a b')).toThrow(SearchError);
    expect(() => parseSearch('a )')).toThrow(SearchError);
  });
});

async function fixture() {
  const col = new Collection(new MemoryPersistence());
  await col.load();
  const lang = col.getOrCreateDeck('Lang::Spanish');
  const math = col.getOrCreateDeck('Math');
  const n1 = col.addNote(NT_BASIC, ['perro', 'dog'], ['animals', 'es::noun'], lang.id);
  const n2 = col.addNote(NT_BASIC, ['gato', 'cat'], ['animals'], lang.id);
  const n3 = col.addNote(NT_BASIC, ['2+2', '4'], [], math.id);
  const n4 = col.addNote(NT_CLOZE, ['{{c1::Paris}} is in {{c2::France}}', ''], ['geo'], math.id);
  const card = (noteId: number) => col.cardsOfNote(noteId)[0];
  return { col, n1, n2, n3, n4, card, lang, math };
}

describe('evaluation', () => {
  it('text, wildcards and fields', async () => {
    const { col } = await fixture();
    expect(col.search('perro')).toHaveLength(1);
    expect(col.search('PER*')).toHaveLength(1);
    expect(col.search('g_to')).toHaveLength(1);
    expect(col.search('back:dog')).toHaveLength(1);
    expect(col.search('front:p*')).toHaveLength(1);
    expect(col.search('Paris')).toHaveLength(2); // two cloze cards
  });

  it('deck: includes children, tag: includes child tags', async () => {
    const { col } = await fixture();
    expect(col.search('deck:Lang')).toHaveLength(2);
    expect(col.search('deck:Lang::Spanish')).toHaveLength(2);
    expect(col.search('deck:Lan*')).toHaveLength(2);
    expect(col.search('-deck:Lang')).toHaveLength(3);
    expect(col.search('tag:es')).toHaveLength(1);
    expect(col.search('tag:animals')).toHaveLength(2);
    expect(col.search('tag:none')).toHaveLength(1);
  });

  it('is:, flag:, card:, note:', async () => {
    const { col, n1, n4, card } = await fixture();
    expect(col.search('is:new')).toHaveLength(5);
    col.setSuspended([card(n1.id).id], true);
    expect(col.search('is:suspended')).toHaveLength(1);
    col.setFlag([card(n1.id).id], 1);
    expect(col.search('flag:1')).toHaveLength(1);
    expect(col.search('card:2')).toHaveLength(1);
    expect(col.search('note:Cloze')).toHaveLength(2);
    expect(col.search(`nid:${n4.id}`)).toHaveLength(2);
    col.toggleMark(n1.id);
    expect(col.search('is:marked')).toHaveLength(1);
  });

  it('rated:, prop:, is:due after answering', async () => {
    const { col, n2, card } = await fixture();
    const c = card(n2.id);
    col.answer(c.id, 4, 3000);
    expect(col.cards.get(c.id)!.state).toBe(CardState.Review);
    expect(col.search('rated:1')).toHaveLength(1);
    expect(col.search('rated:1:4')).toHaveLength(1);
    expect(col.search('rated:1:1')).toHaveLength(0);
    expect(col.search('introduced:1')).toHaveLength(1);
    expect(col.search('prop:ivl>=1')).toHaveLength(1);
    expect(col.search('prop:reps=1')).toHaveLength(1);
    expect(col.search('prop:due>0')).toHaveLength(1);
    expect(col.search('is:due')).toHaveLength(0);
    expect(col.search('is:review')).toHaveLength(1);
    expect(col.search('added:1')).toHaveLength(5);
  });

  it('combined boolean queries', async () => {
    const { col } = await fixture();
    expect(col.search('(perro or gato) -tag:es')).toHaveLength(1);
    expect(col.search('deck:Math (Paris or 2*)')).toHaveLength(3);
  });
});
