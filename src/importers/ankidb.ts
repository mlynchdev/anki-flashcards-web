// Imports the SQLite card store described in schema.sql (decks / sources / cards tables).
// Card text there is plain text, so it is escaped and newlines become <br>.
import type { Collection } from '../core/collection';
import { CardState } from '../core/types';
import { NT_BASIC_EXTRA, NT_CLOZE_TEXT } from '../core/notetypes';
import { cardOrdinals, textToHtml } from '../core/template';
import { openDatabase, rows, tableNames, type ImportResult } from './sqljs';
import type { Database } from 'sql.js';

interface Row {
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
    const list = rows<Row>(db, sql);
    return importRows(col, list);
  } finally {
    db.close();
  }
}

function importRows(col: Collection, list: Row[]): ImportResult {
  const deckNames = [...new Set(list.map((r) => r.deck))];
  const deckIds = new Map(deckNames.map((n) => [n, col.getOrCreateDeck(n).id]));
  let added = 0;
  let updated = 0;
  let cards = 0;
  col.bulk('Import', (api) => {
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
        api.putNote({ ...existing, notetypeId: ntId, fields, tags, mod: now });
        updated++;
        const have = new Set(col.cardsOfNote(existing.id).map((c) => c.ord));
        for (const ord of cardOrdinals(nt, fields)) {
          if (!have.has(ord)) {
            api.putCard(col.newCard(existing.id, deckIds.get(r.deck)!, ord, pos++));
            cards++;
          }
        }
        continue;
      }
      const noteId = api.newId();
      api.putNote({ id: noteId, guid, notetypeId: ntId, fields, tags, mod: now });
      for (const ord of cardOrdinals(nt, fields)) {
        const card = col.newCard(noteId, deckIds.get(r.deck)!, ord, pos);
        api.putCard({ ...card, state: CardState.New });
        cards++;
      }
      pos++;
      added++;
    }
  });
  return {
    format: 'Card store (.db)',
    notesAdded: added,
    notesUpdated: updated,
    cards,
    decks: deckNames.length,
    revlog: 0,
    media: 0,
  };
}
