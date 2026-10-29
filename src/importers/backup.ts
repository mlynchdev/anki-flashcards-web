// Full-collection backup as JSON (notes, cards, review history, decks, presets, note types, settings).
import type { Collection } from '../core/collection';
import type { Card, Deck, DeckConfig, Note, Notetype, Revlog, Settings } from '../core/types';
import type { ImportResult } from './sqljs';

export interface Backup {
  app: 'anki-flashcards-web';
  version: 1;
  exportedAt: string;
  settings: Settings;
  notetypes: Notetype[];
  decks: Deck[];
  configs: DeckConfig[];
  notes: Note[];
  cards: Card[];
  revlog: Revlog[];
  media?: { name: string; type: string; base64: string }[];
}

export async function makeBackup(col: Collection, opts: { deckIds?: Set<number>; media?: boolean } = {}): Promise<Backup> {
  const deckIds = opts.deckIds;
  const cards = [...col.cards.values()].filter((c) => !deckIds || deckIds.has(c.odid ?? c.deckId) || deckIds.has(c.deckId));
  const noteIds = new Set(cards.map((c) => c.noteId));
  const notes = [...col.notes.values()].filter((n) => noteIds.has(n.id));
  const ntIds = new Set(notes.map((n) => n.notetypeId));
  const cardIds = new Set(cards.map((c) => c.id));
  const decks = [...col.decks.values()].filter((d) => !deckIds || deckIds.has(d.id));
  const confIds = new Set(decks.map((d) => d.configId));
  const backup: Backup = {
    app: 'anki-flashcards-web',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: col.settings,
    notetypes: [...col.notetypes.values()].filter((n) => !deckIds || ntIds.has(n.id)),
    decks,
    configs: [...col.configs.values()].filter((c) => !deckIds || confIds.has(c.id)),
    notes,
    cards,
    revlog: [...col.revlog.values()].filter((r) => cardIds.has(r.cardId)),
  };
  if (opts.media !== false && col.mediaNames.size) {
    backup.media = [];
    const allText = notes.map((n) => n.fields.join(' ')).join(' ');
    for (const name of col.mediaNames) {
      if (deckIds && !allText.includes(name)) continue;
      const blob = await col.getMedia(name);
      if (blob) backup.media.push({ name, type: blob.type, base64: await blobToBase64(blob) });
    }
  }
  return backup;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function isBackup(v: unknown): v is Backup {
  return !!v && typeof v === 'object' && (v as Backup).app === 'anki-flashcards-web';
}

/**
 * Restores a backup. With `replace`, the current collection is wiped first; otherwise records are
 * merged (same ids overwrite).
 */
export async function restoreBackup(col: Collection, b: Backup, replace: boolean): Promise<ImportResult> {
  if (replace) await col.wipe();
  col.bulk('Restore', (api) => {
    for (const n of b.notetypes) api.putNotetype(n);
    for (const c of b.configs) api.putConfig(c);
    for (const d of b.decks) api.putDeck(d);
    for (const n of b.notes) api.putNote(n);
    for (const c of b.cards) api.putCard(c);
    for (const r of b.revlog) api.putRevlog(r);
  });
  if (replace) col.saveSettings(b.settings);
  for (const m of b.media ?? []) {
    const bin = atob(m.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await col.putMedia(m.name, new Blob([bytes], { type: m.type }));
  }
  await col.flush();
  return {
    format: 'Backup (.json)',
    notesAdded: b.notes.length,
    notesUpdated: 0,
    cards: b.cards.length,
    decks: b.decks.length,
    revlog: b.revlog.length,
    media: b.media?.length ?? 0,
  };
}
