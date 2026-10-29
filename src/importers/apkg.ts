import { unzipSync } from 'fflate';
import { decompress } from 'fzstd';
import type { Database } from 'sql.js';
import type { Collection } from '../core/collection';
import { DEFAULT_CONFIG_ID, DEFAULT_DECK_ID } from '../core/collection';
import { DEFAULT_CONFIG } from '../core/scheduler';
import { dayOf, dayStart } from '../core/time';
import {
  type Card,
  CardState,
  type Deck,
  type DeckConfig,
  type Note,
  type Notetype,
  type Revlog,
  type RevlogType,
} from '../core/types';
import { openDatabase, rows, type ImportResult, tableNames } from './sqljs';

export type { ImportResult } from './sqljs';

// ---------- protobuf (just enough for Anki's notetype/template/deck/media blobs) ----------

export interface ProtoField {
  field: number;
  /** 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32 */
  wire: number;
  /** Varints as numbers (exact up to 2^53); length-delimited as bytes; fixed as raw bytes. */
  value: number | Uint8Array;
}

/** Reads all top-level fields of a protobuf message. Stops quietly on truncated input. */
export function readProto(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  const varint = (): number | null => {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) return null;
      const b = buf[pos++];
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
    return null;
  };
  while (pos < buf.length) {
    const tag = varint();
    if (tag === null) break;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      const v = varint();
      if (v === null) break;
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      const len = varint();
      if (len === null || pos + len > buf.length) break;
      out.push({ field, wire, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (pos + n > buf.length) break;
      out.push({ field, wire, value: buf.subarray(pos, pos + n) });
      pos += n;
    } else {
      break; // groups / unknown wire types: give up
    }
  }
  return out;
}

const utf8 = new TextDecoder();

export function protoString(fields: ProtoField[], field: number): string {
  const f = fields.find((x) => x.field === field && x.wire === 2);
  return f ? utf8.decode(f.value as Uint8Array) : '';
}

export function protoVarint(fields: ProtoField[], field: number): number {
  const f = fields.find((x) => x.field === field && x.wire === 0);
  return f ? (f.value as number) : 0;
}

/** Anki's new deck table separates hierarchy levels with 0x1f; ours uses `::`. */
export function deckNameFromAnki(name: string): string {
  return name
    .split(/\x1f|::/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('::');
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function isZstd(b: Uint8Array): boolean {
  return b.length >= 4 && ZSTD_MAGIC.every((m, i) => b[i] === m);
}

/** Parses the new-format `media` manifest: MediaEntries { repeated MediaEntry entries = 1 { string name = 1 } }. */
export function parseMediaManifest(raw: Uint8Array): string[] {
  const names: string[] = [];
  for (const e of readProto(raw)) {
    if (e.field === 1 && e.wire === 2) names.push(protoString(readProto(e.value as Uint8Array), 1));
  }
  return names;
}

// ---------- parsed Anki collection ----------

interface AnkiNotetype {
  id: number;
  name: string;
  cloze: boolean;
  fields: string[];
  templates: { name: string; qfmt: string; afmt: string }[];
  css: string;
  sortField: number;
}

interface AnkiDeck {
  id: number;
  name: string;
  filtered: boolean;
  /** Legacy dconf id, if known. */
  conf?: number;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parseJson(s: unknown): Json {
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function readLegacy(db: Database): { notetypes: AnkiNotetype[]; decks: AnkiDeck[]; dconf: Json; crt: number } {
  const col = rows<{ crt: number; models: string; decks: string; dconf: string }>(
    db,
    'SELECT crt, models, decks, dconf FROM col LIMIT 1',
  )[0];
  if (!col) throw new Error('Not an Anki collection: col table is empty');
  const models = parseJson(col.models);
  const notetypes: AnkiNotetype[] = Object.values<Json>(models).map((m) => ({
    id: Number(m.id),
    name: String(m.name ?? 'Imported'),
    cloze: m.type === 1,
    fields: [...(m.flds ?? [])].sort((a: Json, b: Json) => a.ord - b.ord).map((f: Json) => String(f.name)),
    templates: [...(m.tmpls ?? [])]
      .sort((a: Json, b: Json) => a.ord - b.ord)
      .map((t: Json) => ({ name: String(t.name), qfmt: String(t.qfmt ?? ''), afmt: String(t.afmt ?? '') })),
    css: String(m.css ?? ''),
    sortField: Number(m.sortf ?? 0) || 0,
  }));
  const decks: AnkiDeck[] = Object.values<Json>(parseJson(col.decks)).map((d) => ({
    id: Number(d.id),
    name: deckNameFromAnki(String(d.name ?? '')),
    filtered: !!d.dyn,
    conf: d.conf !== undefined ? Number(d.conf) : undefined,
  }));
  return { notetypes, decks, dconf: parseJson(col.dconf), crt: Number(col.crt) };
}

function readModern(db: Database): { notetypes: AnkiNotetype[]; decks: AnkiDeck[]; crt: number } {
  const col = rows<{ crt: number }>(db, 'SELECT crt FROM col LIMIT 1')[0];
  if (!col) throw new Error('Not an Anki collection: col table is empty');
  const fieldRows = rows<{ ntid: number; ord: number; name: string }>(db, 'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord');
  const tmplRows = rows<{ ntid: number; ord: number; name: string; config: Uint8Array }>(
    db,
    'SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord',
  );
  const notetypes: AnkiNotetype[] = rows<{ id: number; name: string; config: Uint8Array }>(
    db,
    'SELECT id, name, config FROM notetypes',
  ).map((n) => {
    const cfg = readProto(n.config ?? new Uint8Array());
    return {
      id: Number(n.id),
      name: n.name,
      cloze: protoVarint(cfg, 1) === 1,
      fields: fieldRows.filter((f) => f.ntid === n.id).map((f) => f.name),
      templates: tmplRows
        .filter((t) => t.ntid === n.id)
        .map((t) => {
          const tc = readProto(t.config ?? new Uint8Array());
          return { name: t.name, qfmt: protoString(tc, 1), afmt: protoString(tc, 2) };
        }),
      css: protoString(cfg, 3),
      sortField: protoVarint(cfg, 2),
    };
  });
  const decks: AnkiDeck[] = rows<{ id: number; name: string; kind: Uint8Array | null }>(
    db,
    'SELECT id, name, kind FROM decks',
  ).map((d) => {
    // DeckKind oneof: normal = 1, filtered = 2.
    const kind = d.kind ? readProto(d.kind) : [];
    return { id: Number(d.id), name: deckNameFromAnki(d.name), filtered: kind.some((f) => f.field === 2) };
  });
  return { notetypes, decks, crt: Number(col.crt) };
}

// ---------- config mapping (legacy JSON) ----------

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function numList(v: unknown, fallback: number[]): number[] {
  return Array.isArray(v) && v.length && v.every((x) => typeof x === 'number') ? (v as number[]) : fallback;
}

function mapConfig(c: Json, id: number, now: number): DeckConfig {
  const D = DEFAULT_CONFIG;
  const params: unknown = Array.isArray(c.fsrsParams6) && c.fsrsParams6.length ? c.fsrsParams6 : c.fsrsWeights;
  return {
    ...structuredClone(D),
    id,
    name: String(c.name ?? 'Imported'),
    newPerDay: num(c.new?.perDay, D.newPerDay),
    revPerDay: num(c.rev?.perDay, D.revPerDay),
    learnSteps: numList(c.new?.delays, D.learnSteps),
    relearnSteps: Array.isArray(c.lapse?.delays) ? numList(c.lapse.delays, []) : D.relearnSteps,
    graduatingIvl: num(c.new?.ints?.[0], D.graduatingIvl),
    easyIvl: num(c.new?.ints?.[1], D.easyIvl),
    startingEase: c.new?.initialFactor ? num(c.new.initialFactor, 2500) / 1000 : D.startingEase,
    easyBonus: num(c.rev?.ease4, D.easyBonus),
    hardFactor: num(c.rev?.hardFactor, D.hardFactor),
    ivlModifier: num(c.rev?.ivlFct, D.ivlModifier),
    maxIvl: num(c.rev?.maxIvl, D.maxIvl),
    lapseMult: num(c.lapse?.mult, D.lapseMult),
    minIvl: num(c.lapse?.minInt, D.minIvl),
    leechThreshold: num(c.lapse?.leechFails, D.leechThreshold),
    leechAction: c.lapse?.leechAction === 0 ? 'suspend' : 'tag',
    buryNew: c.new?.bury === undefined ? D.buryNew : !!c.new.bury,
    buryReview: c.rev?.bury === undefined ? D.buryReview : !!c.rev.bury,
    newOrder: c.new?.order === 0 ? 'random' : 'due',
    desiredRetention: num(c.desiredRetention, D.desiredRetention),
    fsrsParams: Array.isArray(params) && params.every((x) => typeof x === 'number') ? (params as number[]) : [],
    mod: now,
  };
}

// ---------- row types ----------

interface NoteRow {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  tags: string;
  flds: string;
}
interface CardRow {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}
interface RevlogRow {
  id: number;
  cid: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  time: number;
  type: number;
}

function sameFields(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------- main entry ----------

export async function importApkg(
  col: Collection,
  data: Uint8Array,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<ImportResult> {
  const progress = (m: string) => opts.onProgress?.(m);
  progress('Unzipping package');
  const files = unzipSync(data);

  let format: string;
  let dbBytes: Uint8Array;
  if (files['collection.anki21b']) {
    format = 'anki21b';
    dbBytes = decompress(files['collection.anki21b']);
  } else if (files['collection.anki21']) {
    format = 'anki21';
    dbBytes = isZstd(files['collection.anki21']) ? decompress(files['collection.anki21']) : files['collection.anki21'];
  } else if (files['collection.anki2']) {
    format = 'anki2';
    dbBytes = files['collection.anki2'];
  } else {
    throw new Error('No Anki collection found in this package');
  }

  progress('Reading collection');
  const db = await openDatabase(dbBytes);
  try {
    const modern = tableNames(db).has('notetypes');
    const parsed = modern ? { ...readModern(db), dconf: {} as Json } : readLegacy(db);
    const rollover = col.settings.rolloverHour;
    const crtDay = dayOf(parsed.crt * 1000, rollover);

    const noteRows = rows<NoteRow>(db, 'SELECT id, guid, mid, mod, tags, flds FROM notes');
    const cardRows = rows<CardRow>(
      db,
      'SELECT id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards ORDER BY id',
    );
    const revlogRows = rows<RevlogRow>(
      db,
      'SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id',
    );

    // Decks that actually hold cards (through odid for filtered decks).
    const usedDecks = new Set<number>();
    for (const c of cardRows) usedDecks.add(c.odid ? c.odid : c.did);

    const ankiDecks = parsed.decks.filter((d) => !d.filtered && !(d.id === 1 && !usedDecks.has(1)));
    const deckById = new Map<number, Deck>();
    const newDeckIds = new Set<number>();
    for (const d of ankiDecks) {
      const name = d.name || 'Default';
      const existed = col.deckByName(name);
      const deck = col.getOrCreateDeck(name);
      if (!existed) newDeckIds.add(deck.id);
      deckById.set(d.id, deck);
    }
    // Default (id 1) may be used by cards even if it was skipped above for being empty; map it lazily.
    const fallbackDeck = () => deckById.get(1) ?? col.decks.get(DEFAULT_DECK_ID)!;

    const result: ImportResult = { format, notesAdded: 0, notesUpdated: 0, cards: 0, decks: ankiDecks.length, revlog: 0, media: 0 };

    // Latest review per card, for lastReview.
    const lastReviewByCard = new Map<number, number>();
    for (const r of revlogRows) {
      if (r.ease > 0 && r.type !== 4) lastReviewByCard.set(r.cid, r.id); // sorted ascending: last wins
    }

    progress('Importing notes and cards');
    col.bulk('Import', (api) => {
      const now = col.clock();

      // --- deck configs (legacy only) ---
      const configMap = new Map<number, number>(); // dconf id -> our config id
      for (const [key, c] of Object.entries(parsed.dconf)) {
        const aid = Number(key);
        if (aid === 1) {
          configMap.set(aid, DEFAULT_CONFIG_ID);
          continue;
        }
        const existingSameId = col.configs.get(aid);
        if (existingSameId) {
          configMap.set(aid, existingSameId.id);
          continue;
        }
        const cfg = mapConfig(c as Json, aid, now);
        api.putConfig(cfg);
        configMap.set(aid, cfg.id);
      }
      for (const d of ankiDecks) {
        const deck = deckById.get(d.id)!;
        const cid = d.conf !== undefined ? configMap.get(d.conf) : undefined;
        if (newDeckIds.has(deck.id) && cid !== undefined && cid !== deck.configId) {
          const updated = { ...deck, configId: cid, mod: now };
          api.putDeck(updated);
          deckById.set(d.id, updated);
        }
      }

      // --- notetypes ---
      const ntMap = new Map<number, Notetype>();
      for (const a of parsed.notetypes) {
        const existing = col.notetypes.get(a.id);
        if (existing) {
          const same = existing.name === a.name && sameFields(existing.fields, a.fields);
          if (same || a.id > 5) {
            ntMap.set(a.id, existing);
            continue;
          }
        }
        const nt: Notetype = {
          id: existing ? api.newId() : a.id,
          name: a.name,
          kind: a.cloze ? 'cloze' : 'standard',
          fields: a.fields.length ? a.fields : ['Front', 'Back'],
          templates: a.templates.length ? a.templates : [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}' }],
          css: a.css,
          sortField: a.sortField < a.fields.length ? a.sortField : 0,
          mod: now,
        };
        api.putNotetype(nt);
        ntMap.set(a.id, nt);
      }

      // --- notes ---
      const noteMap = new Map<number, Note>(); // anki nid -> our note (new notes only)
      for (const n of noteRows) {
        const nt = ntMap.get(n.mid);
        if (!nt) continue;
        const fields = String(n.flds ?? '').split('\x1f');
        while (fields.length < nt.fields.length) fields.push('');
        if (fields.length > nt.fields.length) fields.length = nt.fields.length;
        const tags = String(n.tags ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const existing = col.noteByGuid(n.guid);
        if (existing) {
          api.putNote({ ...existing, fields, tags, mod: now });
          result.notesUpdated++;
          continue;
        }
        const note: Note = {
          id: col.notes.has(n.id) ? api.newId() : n.id,
          guid: n.guid,
          notetypeId: nt.id,
          fields,
          tags,
          mod: n.mod * 1000,
        };
        api.putNote(note);
        noteMap.set(n.id, note);
        result.notesAdded++;
      }

      // --- cards ---
      const cardMap = new Map<number, number>(); // anki cid -> our card id
      const newBase = col.nextNewPosition();
      const configFor = (deck: Deck) => col.configs.get(deck.configId) ?? col.configs.get(DEFAULT_CONFIG_ID);
      for (const c of cardRows) {
        const note = noteMap.get(c.nid);
        if (!note) continue;
        const nt = col.notetypes.get(note.notetypeId)!;
        if (nt.kind === 'standard' && c.ord >= nt.templates.length) continue;

        const homeId = c.odid ? c.odid : c.did;
        const deck = deckById.get(homeId) ?? fallbackDeck();
        const rawDue = c.odid ? c.odue : c.due;
        const cfg = configFor(deck);

        const state = ([CardState.New, CardState.Learning, CardState.Review, CardState.Relearning] as const)[c.type] ?? CardState.New;
        // A card in the new queue can have a stale type; trust type 0 only for the New state.
        let due: number;
        let step = 0;
        let ease = 0;
        if (state === CardState.New) {
          due = newBase + rawDue;
        } else if (state === CardState.Review) {
          due = crtDay + rawDue;
          ease = c.factor ? c.factor / 1000 : 2.5;
        } else {
          const isDayLearn = c.queue === 3 || rawDue < 1e9;
          due = isDayLearn ? dayStart(crtDay + rawDue, rollover) : rawDue * 1000;
          const total = (state === CardState.Learning ? cfg?.learnSteps.length : cfg?.relearnSteps.length) ?? 0;
          const remaining = c.left % 1000;
          step = total > 0 ? Math.min(total - 1, Math.max(0, total - remaining)) : 0;
          ease = c.factor ? c.factor / 1000 : state === CardState.Relearning ? 2.5 : 0;
        }

        const extra = parseJson(c.data);
        const lastReview = lastReviewByCard.get(c.id) ?? (typeof extra.lrt === 'number' ? extra.lrt * 1000 : undefined);

        const card: Card = {
          id: col.cards.has(c.id) ? api.newId() : c.id,
          noteId: note.id,
          deckId: deck.id,
          ord: c.ord,
          state,
          due,
          ivl: state === CardState.New ? 0 : Math.max(0, c.ivl),
          ease,
          reps: c.reps,
          lapses: c.lapses,
          step,
          suspended: c.queue === -1,
          buried: c.queue === -2 || c.queue === -3 ? 2 : 0,
          flag: c.flags & 7,
          mod: c.mod * 1000,
        };
        if (card.buried) card.buriedDay = col.today;
        if (typeof extra.s === 'number') card.stability = extra.s;
        if (typeof extra.d === 'number') card.difficulty = extra.d;
        if (lastReview !== undefined) card.lastReview = lastReview;
        api.putCard(card);
        cardMap.set(c.id, card.id);
        result.cards++;
      }

      // --- revlog ---
      for (const r of revlogRows) {
        const cardId = cardMap.get(r.cid);
        if (cardId === undefined || col.revlog.has(r.id)) continue;
        const entry: Revlog = {
          id: r.id,
          cardId,
          ease: Math.max(0, Math.min(4, r.ease)) as Revlog['ease'],
          ivl: r.ivl,
          lastIvl: r.lastIvl,
          factor: r.factor,
          time: r.time,
          type: r.type as RevlogType,
        };
        api.putRevlog(entry);
        result.revlog++;
      }
    });

    // --- media ---
    progress('Importing media');
    result.media = await importMedia(col, files, progress);

    progress('Saving');
    await col.flush();
    return result;
  } finally {
    db.close();
  }
}

async function importMedia(
  col: Collection,
  files: Record<string, Uint8Array>,
  progress: (m: string) => void,
): Promise<number> {
  const manifest = files['media'];
  if (!manifest || !manifest.length) return 0;
  let modern = false;
  let names: Map<string, string>; // zip entry -> filename
  if (isZstd(manifest)) {
    modern = true;
    names = new Map(parseMediaManifest(decompress(manifest)).map((n, i) => [String(i), n]));
  } else {
    const j = parseJson(utf8.decode(manifest));
    names = new Map(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  let count = 0;
  const total = names.size;
  for (const [entry, name] of names) {
    const bytes = files[entry];
    if (!bytes || !name || name.includes('/') || name.includes('\\')) continue;
    const content = modern && isZstd(bytes) ? decompress(bytes) : bytes;
    await col.putMedia(name, new Blob([content as BlobPart]));
    count++;
    if (count % 200 === 0) progress(`Importing media (${count}/${total})`);
  }
  return count;
}
