import { useRef, useState } from 'preact/hooks';
import { col, downloadFile, navigate, toast, useCol } from './state';
import { NavBar, SelectRow, SwitchRow, confirm } from './components';
import type { ImportResult } from '../importers/sqljs';
import { DEFAULT_DECK_ID } from '../core/collection';
import { NT_BASIC } from '../core/notetypes';

type Pending = { kind: 'csv'; name: string; text: string };

async function detectAndImport(file: File, onProgress: (m: string) => void): Promise<ImportResult | Pending> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder().decode(buf.slice(0, 16));
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const { importApkg } = await import('../importers/apkg');
    return importApkg(col, buf, { onProgress });
  }
  if (head.startsWith('SQLite format 3')) {
    const { openDatabase, tableNames } = await import('../importers/sqljs');
    const db = await openDatabase(buf);
    const tables = tableNames(db);
    db.close();
    if (tables.has('col')) {
      // A bare Anki collection file: wrap it as a package.
      const { zipSync } = await import('fflate');
      const { importApkg } = await import('../importers/apkg');
      const name = file.name.endsWith('.anki21') ? 'collection.anki21' : 'collection.anki2';
      return importApkg(col, zipSync({ [name]: buf }), { onProgress });
    }
    const { importCardStore } = await import('../importers/ankidb');
    return importCardStore(col, buf);
  }
  const text = new TextDecoder().decode(buf);
  if (/^\s*\{/.test(text)) {
    const { isBackup, restoreBackup } = await import('../importers/backup');
    const parsed = JSON.parse(text);
    if (!isBackup(parsed)) throw new Error('This JSON file is not a backup from this app');
    const replace = col.cards.size > 0 && (await confirm('Restore backup', 'Replace the whole collection with this backup? Choose Cancel to merge it in instead.', 'Replace', true));
    return restoreBackup(col, parsed, replace);
  }
  return { kind: 'csv', name: file.name, text };
}

export function ImportScreen() {
  useCol();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    setBusy(`Reading ${file.name}…`);
    try {
      const r = await detectAndImport(file, setBusy);
      if ('kind' in r) setPending(r);
      else {
        await col.flush();
        setResult(r);
        toast('Import complete');
      }
    } catch (e) {
      console.error(e);
      toast(`Import failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div class="screen">
      <NavBar title="Import" backTo="" />
      <div class="content">
        {pending ? (
          <CsvOptions
            pending={pending}
            onDone={(r) => {
              setPending(null);
              if (r) setResult(r);
            }}
          />
        ) : (
          <>
            <div
              class={`drop-zone ${over ? 'over' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void handle(e.dataTransfer?.files[0]);
              }}
            >
              <div style="font-size:30px">⬇︎</div>
              <p style="margin:8px 0 4px;font-weight:600;color:var(--fg)">{busy ?? 'Choose a file or drop it here'}</p>
              <p style="margin:0;font-size:13px">.apkg · .colpkg · .anki2 · .db card store · .json backup · .csv / .txt</p>
            </div>
            <input
              ref={input}
              type="file"
              id="import-file"
              accept=".apkg,.colpkg,.anki2,.anki21,.db,.sqlite,.json,.csv,.tsv,.txt"
              style="display:none"
              onChange={(e) => void handle((e.target as HTMLInputElement).files?.[0])}
            />
            <p class="hint-text">
              Files are read in your browser and stored locally in IndexedDB. Nothing is uploaded. Importing the same
              file again updates existing notes instead of duplicating them.
            </p>
          </>
        )}

        {result && (
          <>
            <div class="group-title">Imported</div>
            <div class="group">
              <div class="row static"><div class="grow">Format</div><div class="value">{result.format}</div></div>
              <div class="row static"><div class="grow">New notes</div><div class="value">{result.notesAdded}</div></div>
              <div class="row static"><div class="grow">Updated notes</div><div class="value">{result.notesUpdated}</div></div>
              <div class="row static"><div class="grow">Cards</div><div class="value">{result.cards}</div></div>
              <div class="row static"><div class="grow">Decks</div><div class="value">{result.decks}</div></div>
              <div class="row static"><div class="grow">Review history</div><div class="value">{result.revlog}</div></div>
              <div class="row static"><div class="grow">Media files</div><div class="value">{result.media}</div></div>
            </div>
            <button class="btn primary block" onClick={() => navigate('', true)}>
              Go to decks
            </button>
          </>
        )}

        <div class="group-title">Export</div>
        <div class="group">
          <button
            class="row"
            onClick={async () => {
              const { makeBackup } = await import('../importers/backup');
              const b = await makeBackup(col);
              downloadFile(`flashcards-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(b), 'application/json');
            }}
          >
            <div class="grow">
              Back up collection
              <div class="sub">Everything incl. review history and media, as JSON. Restore by importing it.</div>
            </div>
          </button>
          <button
            class="row"
            onClick={async () => {
              const { exportNotesText } = await import('../importers/csv');
              downloadFile('all-notes.txt', exportNotesText(col, [...col.cards.keys()]), 'text/plain');
            }}
          >
            <div class="grow">
              Export notes as text
              <div class="sub">Tab-separated, re-importable into Anki ("Notes in Plain Text").</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function CsvOptions(props: { pending: Pending; onDone: (r: ImportResult | null) => void }) {
  const decks = col.sortedDecks().filter((d) => !d.dyn);
  const [deckId, setDeckId] = useState(col.settings.currentDeckId && col.decks.has(col.settings.currentDeckId) ? col.settings.currentDeckId : DEFAULT_DECK_ID);
  const [ntId, setNtId] = useState(NT_BASIC);
  const [html, setHtml] = useState(false);
  const [header, setHeader] = useState(false);
  const [tagsCol, setTagsCol] = useState(0);
  const preview = props.pending.text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).slice(0, 4);
  return (
    <>
      <div class="group-title">Import {props.pending.name}</div>
      <pre class="code">{preview.join('\n')}</pre>
      <div class="group">
        <SelectRow label="Deck" value={deckId} options={decks.map((d) => ({ label: d.name, value: d.id }))} onChange={setDeckId} />
        <SelectRow
          label="Note type"
          value={ntId}
          options={[...col.notetypes.values()].map((n) => ({ label: `${n.name} (${n.fields.join(', ')})`, value: n.id }))}
          onChange={setNtId}
        />
        <SwitchRow label="First row is a header" checked={header} onChange={setHeader} />
        <SwitchRow label="Allow HTML in fields" checked={html} onChange={setHtml} />
        <SelectRow
          label="Tags column"
          value={tagsCol}
          options={[{ label: 'None', value: 0 }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ label: `Column ${n}`, value: n }))]}
          onChange={setTagsCol}
        />
      </div>
      <p class="hint-text">Columns map to the note type's fields in order. Anki “#separator / #tags column” headers are honoured.</p>
      <div class="dialog-actions">
        <button class="btn" onClick={() => props.onDone(null)}>
          Cancel
        </button>
        <button
          class="btn primary"
          onClick={async () => {
            const { importCsv } = await import('../importers/csv');
            try {
              const r = importCsv(col, props.pending.text, { deckId, notetypeId: ntId, html, hasHeader: header, tagsColumn: tagsCol, extraTags: [] });
              await col.flush();
              props.onDone(r);
            } catch (e) {
              toast((e as Error).message);
            }
          }}
        >
          Import
        </button>
      </div>
    </>
  );
}
