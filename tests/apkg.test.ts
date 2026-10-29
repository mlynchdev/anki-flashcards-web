import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Collection } from '../src/core/collection';
import { MemoryPersistence } from '../src/core/db';
import { dayOf } from '../src/core/time';
import { CardState } from '../src/core/types';
import {
  deckNameFromAnki,
  importApkg,
  isZstd,
  parseMediaManifest,
  protoString,
  protoVarint,
  readProto,
} from '../src/importers/apkg';
import { getSql } from '../src/importers/sqljs';

const CRT = Math.floor(new Date(2025, 0, 1, 12).getTime() / 1000);
const ROLL = 4;
const CRT_DAY = dayOf(CRT * 1000, ROLL);

const BASIC_ID = 1111111111111;
const CLOZE_ID = 2222222222222;
const PARENT = 3333333333331;
const CHILD = 3333333333332;

async function buildApkg(): Promise<Uint8Array> {
  const SQL = await getSql();
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text);
CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
CREATE TABLE graves (usn integer, oid integer, type integer);`);

  const models = {
    [BASIC_ID]: {
      id: BASIC_ID,
      name: 'Basic Test',
      type: 0,
      flds: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
      css: '.card { color: red; }',
      sortf: 0,
    },
    [CLOZE_ID]: {
      id: CLOZE_ID,
      name: 'Cloze Test',
      type: 1,
      flds: [
        { name: 'Text', ord: 0 },
        { name: 'Back Extra', ord: 1 },
      ],
      tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }],
      css: '',
      sortf: 0,
    },
  };
  const decks = {
    '1': { id: 1, name: 'Default', conf: 1, dyn: 0 },
    [PARENT]: { id: PARENT, name: 'Parent', conf: 7, dyn: 0 },
    [CHILD]: { id: CHILD, name: 'Parent::Child', conf: 7, dyn: 0 },
    '3333333333339': { id: 3333333333339, name: 'Filtered', dyn: 1 },
  };
  const dconf = {
    '1': { id: 1, name: 'Default' },
    '7': {
      id: 7,
      name: 'Custom',
      new: { perDay: 5, delays: [1, 5, 15], ints: [2, 6], initialFactor: 2300 },
      rev: { perDay: 77, maxIvl: 1000, hardFactor: 1.1 },
      lapse: { delays: [10, 20], leechFails: 4, leechAction: 0 },
      desiredRetention: 0.85,
    },
  };
  db.run('INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, "{}", ?, ?, ?, "{}")', [
    CRT,
    JSON.stringify(models),
    JSON.stringify(decks),
    JSON.stringify(dconf),
  ]);

  const note = (id: number, guid: string, mid: number, tags: string, flds: string[]) =>
    db.run('INSERT INTO notes VALUES (?, ?, ?, 1700000000, 0, ?, ?, 0, 0, 0, "")', [id, guid, mid, tags, flds.join('\x1f')]);
  note(1700000000001, 'g-new', BASIC_ID, ' foo bar ', ['Q new', 'A new']);
  note(1700000000002, 'g-learn', BASIC_ID, '', ['Q learn', 'A learn']);
  note(1700000000003, 'g-review', BASIC_ID, ' leech ', ['Q review', 'A review <img src="pic.png">']);
  note(1700000000004, 'g-susp', BASIC_ID, '', ['Q susp', 'A susp']);
  note(1700000000005, 'g-cloze', CLOZE_ID, '', ['{{c1::one}} and {{c2::two}}', 'extra']);

  const card = (
    id: number,
    nid: number,
    did: number,
    ord: number,
    type: number,
    queue: number,
    due: number,
    ivl: number,
    factor: number,
    extra: { left?: number; flags?: number; data?: string; reps?: number; lapses?: number } = {},
  ) =>
    db.run('INSERT INTO cards VALUES (?, ?, ?, ?, 1700000000, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)', [
      id, nid, did, ord, type, queue, due, ivl, factor, extra.reps ?? 0, extra.lapses ?? 0, extra.left ?? 0, extra.flags ?? 0, extra.data ?? '',
    ]);
  card(1800000000001, 1700000000001, PARENT, 0, 0, 0, 3, 0, 0);
  card(1800000000002, 1700000000002, CHILD, 0, 1, 1, 1_900_000_000, 0, 0, { left: 1002, reps: 1 });
  card(1800000000003, 1700000000003, CHILD, 0, 2, 2, 100, 21, 2350, {
    reps: 5,
    lapses: 1,
    flags: 3,
    data: JSON.stringify({ s: 21.5, d: 5.25, lrt: 1_750_000_000 }),
  });
  card(1800000000004, 1700000000004, PARENT, 0, 2, -1, 50, 10, 2500);
  card(1800000000005, 1700000000005, CHILD, 0, 0, 0, 1, 0, 0);
  card(1800000000006, 1700000000005, CHILD, 1, 0, 0, 2, 0, 0);

  const rl = (id: number, cid: number, ease: number, ivl: number, lastIvl: number, factor: number, time: number, type: number) =>
    db.run('INSERT INTO revlog VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)', [id, cid, ease, ivl, lastIvl, factor, time, type]);
  rl(1750000001000, 1800000000003, 3, 21, 10, 2350, 4000, 1);
  rl(1750000002000, 1800000000003, 3, 21, 21, 2350, 3000, 1);
  rl(1750000003000, 1800000000002, 1, -60, 0, 0, 2000, 0);

  const dbBytes = db.export();
  db.close();
  return zipSync({
    'collection.anki2': dbBytes,
    media: new TextEncoder().encode(JSON.stringify({ '0': 'pic.png' })),
    '0': new Uint8Array([137, 80, 78, 71]),
  });
}

async function freshCol() {
  const col = new Collection(new MemoryPersistence());
  await col.load();
  return col;
}

describe('importApkg (legacy schema)', () => {
  it('imports decks, notes, cards, revlog and media', async () => {
    const col = await freshCol();
    const progress: string[] = [];
    const res = await importApkg(col, await buildApkg(), { onProgress: (m) => progress.push(m) });

    expect(res).toMatchObject({ format: 'anki2', notesAdded: 5, notesUpdated: 0, cards: 6, revlog: 3, media: 1 });
    expect(progress.length).toBeGreaterThan(0);

    const parent = col.deckByName('Parent');
    const child = col.deckByName('Parent::Child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(col.deckByName('Filtered')).toBeUndefined();
    expect(col.cards.get(1800000000001)!.deckId).toBe(parent!.id);
    expect(col.cards.get(1800000000002)!.deckId).toBe(child!.id);

    // Deck config mapped from dconf and assigned to the imported decks.
    const cfg = col.configs.get(child!.configId)!;
    expect(cfg.name).toBe('Custom');
    expect(cfg).toMatchObject({
      newPerDay: 5,
      revPerDay: 77,
      learnSteps: [1, 5, 15],
      relearnSteps: [10, 20],
      graduatingIvl: 2,
      easyIvl: 6,
      startingEase: 2.3,
      hardFactor: 1.1,
      maxIvl: 1000,
      leechThreshold: 4,
      leechAction: 'suspend',
      desiredRetention: 0.85,
    });

    expect(col.notes.size).toBe(5);
    const n1 = col.notes.get(1700000000001)!;
    expect(n1.tags).toEqual(['foo', 'bar']);
    expect(n1.fields).toEqual(['Q new', 'A new']);
    expect(col.notetypes.get(CLOZE_ID)!.kind).toBe('cloze');
    expect(col.notetypes.get(BASIC_ID)!.templates[0].qfmt).toBe('{{Front}}');
    expect(col.cardsOfNote(1700000000005).map((c) => c.ord).sort()).toEqual([0, 1]);

    // New card: after existing new cards (none) -> 1 + anki due 3.
    const newCard = col.cards.get(1800000000001)!;
    expect(newCard.state).toBe(CardState.New);
    expect(newCard.due).toBe(1 + 3);
    expect(newCard.ease).toBe(0);

    const learn = col.cards.get(1800000000002)!;
    expect(learn.state).toBe(CardState.Learning);
    expect(learn.due).toBe(1_900_000_000 * 1000);
    expect(learn.step).toBe(1); // 3 steps, left%1000 = 2 -> index 1

    const review = col.cards.get(1800000000003)!;
    expect(review.state).toBe(CardState.Review);
    expect(review.due).toBe(CRT_DAY + 100);
    expect(review.ivl).toBe(21);
    expect(review.ease).toBeCloseTo(2.35);
    expect(review.flag).toBe(3);
    expect(review.reps).toBe(5);
    expect(review.lapses).toBe(1);
    expect(review.stability).toBe(21.5);
    expect(review.difficulty).toBe(5.25);
    expect(review.lastReview).toBe(1750000002000);

    const susp = col.cards.get(1800000000004)!;
    expect(susp.suspended).toBe(true);
    expect(review.suspended).toBe(false);

    expect(col.revlog.size).toBe(3);
    expect(col.revlog.get(1750000001000)).toMatchObject({ cardId: 1800000000003, ease: 3, ivl: 21, lastIvl: 10, factor: 2350, time: 4000, type: 1 });

    expect(col.mediaNames.has('pic.png')).toBe(true);
    const blob = await col.getMedia('pic.png');
    // MemoryPersistence has no media getter; presence in mediaNames is what we can check.
    expect(blob === undefined || blob.size === 4).toBe(true);
  });

  it('updates instead of duplicating on re-import and keeps scheduling', async () => {
    const col = await freshCol();
    const apkg = await buildApkg();
    await importApkg(col, apkg);
    const before = col.cards.get(1800000000003)!;
    const res = await importApkg(col, apkg);
    expect(res).toMatchObject({ notesAdded: 0, notesUpdated: 5, cards: 0, revlog: 0 });
    expect(col.notes.size).toBe(5);
    expect(col.cards.size).toBe(6);
    expect(col.revlog.size).toBe(3);
    expect(col.cards.get(1800000000003)).toEqual(before);
    // No duplicate configs/decks either.
    expect([...col.decks.values()].filter((d) => d.name === 'Parent').length).toBe(1);
    expect([...col.configs.values()].filter((c) => c.name === 'Custom').length).toBe(1);
  });

  it('gives imported cards positions after existing new cards', async () => {
    const col = await freshCol();
    const deck = col.getOrCreateDeck('Existing');
    col.bulk('seed', (api) =>
      api.putCard({
        id: 5, noteId: 99, deckId: deck.id, ord: 0, state: CardState.New, due: 40, ivl: 0, ease: 0,
        reps: 0, lapses: 0, step: 0, suspended: false, buried: 0, flag: 0, mod: 0,
      }),
    );
    await importApkg(col, await buildApkg());
    expect(col.cards.get(1800000000001)!.due).toBe(41 + 3);
  });

  it('rejects packages without a collection', async () => {
    const col = await freshCol();
    await expect(importApkg(col, zipSync({ foo: new Uint8Array([1]) }))).rejects.toThrow();
  });
});

describe('importer helpers', () => {
  it('converts hierarchical deck names', () => {
    expect(deckNameFromAnki('A\x1fB\x1fC')).toBe('A::B::C');
    expect(deckNameFromAnki('Plain')).toBe('Plain');
    expect(deckNameFromAnki('A::B')).toBe('A::B');
  });

  it('reads protobuf varints, strings and skips fixed fields', () => {
    const te = new TextEncoder();
    const q = te.encode('{{Front}}');
    const a = te.encode('{{Back}}');
    const msg = new Uint8Array([
      0x08, 0x01, // field 1 varint = 1
      0x15, 1, 2, 3, 4, // field 2 fixed32 (skipped)
      0x19, 1, 2, 3, 4, 5, 6, 7, 8, // field 3 fixed64 (skipped)
      0x22, q.length, ...q, // field 4 string
      0x2a, a.length, ...a, // field 5 string
      0x30, 0xac, 0x02, // field 6 varint = 300
    ]);
    const f = readProto(msg);
    expect(f.map((x) => x.field)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(protoVarint(f, 1)).toBe(1);
    expect(protoString(f, 4)).toBe('{{Front}}');
    expect(protoString(f, 5)).toBe('{{Back}}');
    expect(protoVarint(f, 6)).toBe(300);
    expect(protoVarint(f, 9)).toBe(0);
    expect(protoString(f, 9)).toBe('');
  });

  it('stops quietly on truncated protobuf', () => {
    expect(readProto(new Uint8Array([0x0a, 10, 1, 2]))).toEqual([]);
  });

  it('parses the media manifest and detects zstd', () => {
    const te = new TextEncoder();
    const entry = (name: string) => {
      const n = te.encode(name);
      const inner = new Uint8Array([0x0a, n.length, ...n, 0x10, 5]);
      return [0x0a, inner.length, ...inner];
    };
    const manifest = new Uint8Array([...entry('a.jpg'), ...entry('b.mp3')]);
    expect(parseMediaManifest(manifest)).toEqual(['a.jpg', 'b.mp3']);
    expect(isZstd(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0]))).toBe(true);
    expect(isZstd(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });
});
