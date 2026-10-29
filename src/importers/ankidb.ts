// Imports the SQLite card store described in schema.sql (decks / sources / cards tables).
// Card text there is plain text, so it is escaped and newlines become <br>.
import type { Collection } from '../core/collection';
import { CardState } from '../core/types';
import { NT_BASIC_EXTRA, NT_CLOZE_TEXT } from '../core/notetypes';
import { cardOrdinals, textToHtml } from '../core/template';
import { openDatabase, rows, tableNames, type ImportResult } from './sqljs';
import type { Database } from 'sql.js';

export interface CardStoreRow {
  id?: number;
  created_at?: string;
  guid: string;
  deck: string;
  card_type: string;
  front: string;
  back: string;
  extra: string | null;
  tags: string;
  lesson: string | null;
  url: string | null;
}

export function isCardStoreDb(db: Database): boolean {
  const t = tableNames(db);
  return t.has('cards') && t.has('decks') && !t.has('col');
}

export async function importCardStore(col: Collection, data: Uint8Array): Promise<ImportResult> {
  const db = await openDatabase(data);
  try {
    if (!isCardStoreDb(db)) throw new Error('Not a card store database (expected decks and cards tables)');
    const hasSources = tableNames(db).has('sources');
    const sql = hasSources
      ? `SELECT c.guid, d.name AS deck, c.card_type, c.front, c.back, c.extra, c.tags, s.title AS lesson, s.url
         FROM cards c JOIN decks d ON d.id = c.deck_id LEFT JOIN sources s ON s.id = c.source_id
         ORDER BY d.name, s.slug, c.position`
      : `SELECT c.guid, d.name AS deck, c.card_type, c.front, c.back, c.extra, c.tags, NULL AS lesson, NULL AS url
         FROM cards c JOIN decks d ON d.id = c.deck_id ORDER BY d.name, c.position`;
    const list = rows<CardStoreRow>(db, sql);
    return importRows(col, list);
  } finally {
    db.close();
  }
}

/** FNV-1a, for deterministic deck ids. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * Imports card store rows. With `deterministic`, deck/note/card ids are derived from the source
 * rows so every device that loads the same content (e.g. from the D1 API) agrees on ids, which
 * lets per-user scheduling state sync between devices.
 */
export function importRows(col: Collection, list: CardStoreRow[], opts: { deterministic?: boolean } = {}): ImportResult {
  const deckNames = [...new Set(list.map((r) => r.deck))];
  const deckIds = new Map<string, number>();
  let added = 0;
  let updated = 0;
  let cards = 0;
  col.bulk('Import', (api) => {
    for (const name of deckNames) {
      if (!opts.deterministic) {
        deckIds.set(name, col.getOrCreateDeck(name).id);
        continue;
      }
      const parts = name.split('::');
      for (let i = 1; i <= parts.length; i++) {
        const n = parts.slice(0, i).join('::');
        let d = col.deckByName(n);
        if (!d) {
          d = { id: 3_000_000_000 + hash32(n.toLowerCase()), name: n, configId: 1, mod: Date.now() };
          api.putDeck(d);
        }
        if (i === parts.length) deckIds.set(name, d.id);
      }
    }
    let pos = col.nextNewPosition();
    for (const r of list) {
      const cloze = r.card_type === 'cloze';
      const ntId = cloze ? NT_CLOZE_TEXT : NT_BASIC_EXTRA;
      const nt = col.notetypes.get(ntId)!;
      const fields = [textToHtml(r.front), textToHtml(r.back ?? ''), textToHtml(r.extra ?? '')];
      const tags = r.tags.split(/\s+/).filter(Boolean);
      const guid = `cs-${r.guid}`;
      const existing = col.noteByGuid(guid);
      const now = Date.now();
      if (existing) {
        const same =
          existing.notetypeId === ntId &&
          JSON.stringify(existing.fields) === JSON.stringify(fields) &&
          JSON.stringify(existing.tags) === JSON.stringify(tags);
        if (!same) {
          api.putNote({ ...existing, notetypeId: ntId, fields, tags, mod: now });
          updated++;
        }
        const have = new Set(col.cardsOfNote(existing.id).map((c) => c.ord));
        for (const ord of cardOrdinals(nt, fields)) {
          if (!have.has(ord)) {
            const card = col.newCard(existing.id, deckIds.get(r.deck)!, ord, pos++);
            if (opts.deterministic) card.id = existing.id * 100 + ord;
            api.putCard(card);
            cards++;
          }
        }
        continue;
      }
      let noteId = api.newId();
      if (opts.deterministic && r.id !== undefined) {
        const base = Date.parse(r.created_at ?? '') || 1_700_000_000_000;
        const candidate = Math.floor(base / 1000) * 1000 + (r.id % 1000);
        if (!col.notes.has(candidate)) noteId = candidate;
      }
      api.putNote({ id: noteId, guid, notetypeId: ntId, fields, tags, mod: now });
      for (const ord of cardOrdinals(nt, fields)) {
        const card = col.newCard(noteId, deckIds.get(r.deck)!, ord, opts.deterministic && r.id !== undefined ? r.id : pos);
        if (opts.deterministic && r.id !== undefined) card.id = noteId * 100 + ord;
        api.putCard({ ...card, state: CardState.New });
        cards++;
      }
      pos++;
      added++;
    }
  }, { lowPriority: opts.deterministic });
  return {
    format: opts.deterministic ? 'Card store (server)' : 'Card store (.db)',
    notesAdded: added,
    notesUpdated: updated,
    cards,
    decks: deckNames.length,
    revlog: 0,
    media: 0,
  };
}
