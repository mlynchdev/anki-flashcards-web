import type { Collection } from '../core/collection';
import { cardOrdinals } from '../core/template';
import type { ImportResult } from './sqljs';

/** Parses delimited text (RFC 4180 quoting). */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((f) => f.trim() !== ''));
}

export interface CsvHeaders {
  separator?: string;
  html?: boolean;
  tagsColumn?: number;
  deckColumn?: number;
  notetypeColumn?: number;
  deck?: string;
  notetype?: string;
  columns?: string[];
}

/** Reads Anki's `#key:value` file headers (from "Notes in Plain Text" exports). */
export function readHeaders(text: string): { headers: CsvHeaders; body: string } {
  const headers: CsvHeaders = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  const seps: Record<string, string> = { tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':' };
  for (; i < lines.length && lines[i].startsWith('#'); i++) {
    const m = /^#([a-z ]+):(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'separator') headers.separator = seps[val.toLowerCase()] ?? val;
    else if (key === 'html') headers.html = val === 'true';
    else if (key === 'tags column') headers.tagsColumn = Number(val);
    else if (key === 'deck column') headers.deckColumn = Number(val);
    else if (key === 'notetype column') headers.notetypeColumn = Number(val);
    else if (key === 'deck') headers.deck = val;
    else if (key === 'notetype') headers.notetype = val;
    else if (key === 'columns') headers.columns = val.split(headers.separator ?? '\t');
  }
  return { headers, body: lines.slice(i).join('\n') };
}

export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = ['\t', ';', ','].map((d) => [d, sample.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : '\t';
}

export interface CsvOptions {
  deckId: number;
  notetypeId: number;
  /** Treat field text as HTML (otherwise it is escaped). */
  html: boolean;
  /** Skip the first row. */
  hasHeader: boolean;
  /** Column holding space separated tags, 1-based; 0 = none. */
  tagsColumn: number;
  extraTags: string[];
}

export function importCsv(col: Collection, text: string, opts: CsvOptions): ImportResult {
  const { headers, body } = readHeaders(text.replace(/^﻿/, ''));
  const delim = headers.separator ?? sniffDelimiter(body);
  let table = parseDelimited(body, delim);
  if (opts.hasHeader) table = table.slice(1);
  const html = headers.html ?? opts.html;
  const tagsCol = headers.tagsColumn ?? opts.tagsColumn;
  const deckCol = headers.deckColumn ?? 0;
  const nt = col.notetypes.get(opts.notetypeId);
  if (!nt) throw new Error('Unknown note type');
  const decks = new Map<string, number>();
  for (const r of table) {
    if (deckCol && r[deckCol - 1]) decks.set(r[deckCol - 1], 0);
  }
  for (const name of decks.keys()) decks.set(name, col.getOrCreateDeck(name).id);
  const fallbackDeck = headers.deck ? col.getOrCreateDeck(headers.deck).id : opts.deckId;

  let added = 0;
  let cards = 0;
  col.bulk('Import', (api) => {
    let pos = col.nextNewPosition();
    for (const r of table) {
      const values: string[] = [];
      let tags: string[] = [...opts.extraTags];
      r.forEach((v, i) => {
        if (i + 1 === tagsCol) tags = tags.concat(v.split(/\s+/).filter(Boolean));
        else if (i + 1 === deckCol || i + 1 === headers.notetypeColumn) return;
        else values.push(html ? v : escape(v));
      });
      const fields = nt.fields.map((_, i) => values[i] ?? '');
      if (values.length > nt.fields.length) {
        fields[nt.fields.length - 1] += values.slice(nt.fields.length).map((v) => `<br>${v}`).join('');
      }
      const ords = cardOrdinals(nt, fields);
      if (!ords.length) continue;
      const deckId = (deckCol && decks.get(r[deckCol - 1])) || fallbackDeck;
      const noteId = api.newId();
      api.putNote({ id: noteId, guid: `csv-${noteId.toString(36)}`, notetypeId: nt.id, fields, tags, mod: Date.now() });
      for (const ord of ords) {
        api.putCard(col.newCard(noteId, deckId, ord, pos));
        cards++;
      }
      pos++;
      added++;
    }
  });
  return { format: 'Text/CSV', notesAdded: added, notesUpdated: 0, cards, decks: decks.size, revlog: 0, media: 0 };
}

function escape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
}

/** Exports notes as tab-separated text with Anki's file headers. */
export function exportNotesText(col: Collection, cardIds: number[]): string {
  const noteIds = [...new Set(cardIds.map((id) => col.cards.get(id)?.noteId).filter((x): x is number => !!x))];
  const lines = ['#separator:tab', '#html:true', '#notetype column:1', '#deck column:2', '#tags column:3'];
  for (const nid of noteIds) {
    const note = col.notes.get(nid)!;
    const nt = col.notetypes.get(note.notetypeId);
    const card = col.cardsOfNote(nid)[0];
    const deck = col.decks.get(card?.odid ?? card?.deckId ?? 0)?.name ?? '';
    const cells = [nt?.name ?? '', deck, note.tags.join(' '), ...note.fields].map(quoteCell);
    lines.push(cells.join('\t'));
  }
  return lines.join('\n') + '\n';
}

function quoteCell(v: string): string {
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
