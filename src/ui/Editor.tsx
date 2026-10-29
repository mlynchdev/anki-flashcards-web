import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { col, toast, useCol } from './state';
import { NavBar, choose, confirm } from './components';
import { clozeNumbers, renderCard } from '../core/template';
import { CardView, sanitize } from './CardView';
import { DEFAULT_DECK_ID } from '../core/collection';
import { NT_BASIC } from '../core/notetypes';

function FieldEditor(props: {
  name: string;
  value: string;
  onChange: (html: string) => void;
  autofocus?: boolean;
  registerFocus: (el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Only push external value changes into the DOM (keeps the caret stable while typing).
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== props.value) ref.current.innerHTML = sanitize(props.value);
  }, [props.value]);
  useEffect(() => {
    if (props.autofocus) ref.current?.focus();
  }, []);
  return (
    <label class="field">
      <span>{props.name}</span>
      <div
        ref={ref}
        class="field-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={props.name}
        data-placeholder={props.name}
        onFocus={() => ref.current && props.registerFocus(ref.current)}
        onInput={() => props.onChange(normalizeHtml(ref.current!.innerHTML))}
        onPaste={(e) => {
          // Paste as plain text to avoid bringing in foreign styling.
          e.preventDefault();
          const text = e.clipboardData?.getData('text/plain') ?? '';
          document.execCommand('insertText', false, text);
        }}
      />
    </label>
  );
}

function normalizeHtml(html: string): string {
  const h = html.replace(/<div><br><\/div>/g, '<br>').replace(/<div>/g, '<br>').replace(/<\/div>/g, '');
  return h === '<br>' ? '' : h;
}

export function TagInput(props: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState('');
  const all = useMemo(() => [...col.allTags().keys()], [col.version]);
  const suggestions = text ? all.filter((t) => t.toLowerCase().startsWith(text.toLowerCase()) && !props.tags.includes(t)).slice(0, 6) : [];
  const commit = (raw: string) => {
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length) props.onChange([...props.tags, ...parts.filter((p) => !props.tags.includes(p))]);
    setText('');
  };
  return (
    <div>
      <div class="tag-input">
        {props.tags.map((t) => (
          <span class="tag">
            {t}
            <button aria-label={`Remove ${t}`} onClick={() => props.onChange(props.tags.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={text}
          placeholder="Add tags…"
          aria-label="Tags"
          autocapitalize="off"
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            if (/\s$/.test(v)) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(text);
            } else if (e.key === 'Backspace' && !text && props.tags.length) {
              props.onChange(props.tags.slice(0, -1));
            }
          }}
          onBlur={() => text && commit(text)}
        />
      </div>
      {suggestions.length > 0 && (
        <div class="chips" style="padding:6px 0 0">
          {suggestions.map((s) => (
            <button class="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Add a new note (noteId undefined) or edit an existing one. */
export function NoteEditor(props: { noteId?: number; deckId?: number; onDone: () => void }) {
  useCol();
  const existing = props.noteId ? col.notes.get(props.noteId) : undefined;
  const lastNt = Number(localStorage.getItem('add.notetype')) || NT_BASIC;
  const [ntId, setNtId] = useState(existing?.notetypeId ?? (col.notetypes.has(lastNt) ? lastNt : NT_BASIC));
  const nt = col.notetypes.get(ntId)!;
  const defaultDeck =
    props.deckId ??
    (Number(localStorage.getItem('add.deck')) || col.settings.currentDeckId || DEFAULT_DECK_ID);
  const [deckId, setDeckId] = useState(col.decks.has(defaultDeck) && !col.decks.get(defaultDeck)!.dyn ? defaultDeck : DEFAULT_DECK_ID);
  const [fields, setFields] = useState<string[]>(existing ? [...existing.fields] : nt.fields.map(() => ''));
  const [tags, setTags] = useState<string[]>(existing ? [...existing.tags] : JSON.parse(localStorage.getItem('add.tags') ?? '[]'));
  const [preview, setPreview] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const focused = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!existing) setFields((f) => nt.fields.map((_, i) => f[i] ?? ''));
  }, [ntId]);

  const dirty = existing
    ? JSON.stringify(fields) !== JSON.stringify(existing.fields) || JSON.stringify(tags) !== JSON.stringify(existing.tags)
    : fields.some((f) => f.trim());

  const close = async () => {
    if (dirty && !(await confirm('Discard changes?', undefined, 'Discard', true))) return;
    props.onDone();
  };

  const save = () => {
    try {
      if (existing) {
        col.updateNote({ ...existing, notetypeId: ntId, fields, tags });
        toast('Saved');
        props.onDone();
      } else {
        col.addNote(ntId, fields, tags, deckId);
        localStorage.setItem('add.notetype', String(ntId));
        localStorage.setItem('add.deck', String(deckId));
        localStorage.setItem('add.tags', JSON.stringify(tags));
        setFields(nt.fields.map(() => ''));
        setResetKey((k) => k + 1);
        toast('Added');
      }
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const exec = (cmd: string) => {
    focused.current?.focus();
    document.execCommand(cmd);
  };

  const insertCloze = (sameNumber: boolean) => {
    const el = focused.current;
    if (!el) return toast('Select text in a field first');
    const all = fields.join(' ');
    const nums = clozeNumbers(all);
    const max = nums.length ? Math.max(...nums) : 0;
    const n = sameNumber ? Math.max(1, max) : max + 1;
    el.focus();
    const sel = window.getSelection();
    const text = sel?.toString() ?? '';
    document.execCommand('insertText', false, `{{c${n}::${text}}}`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        insertCloze(e.altKey);
      } else if (e.key === 'Escape') {
        void close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cards = existing ? col.cardsOfNote(existing.id) : [];
  const previewHtml = useMemo(() => {
    if (!preview) return null;
    try {
      const r = renderCard(nt, fields, nt.kind === 'cloze' ? Math.max(0, (clozeNumbers(fields.join(' '))[0] ?? 1) - 1) : 0, {
        tags,
        deck: col.decks.get(deckId)?.name ?? '',
      });
      return r;
    } catch {
      return null;
    }
  }, [preview, fields, ntId]);

  const decks = col.sortedDecks().filter((d) => !d.dyn);

  return (
    <div class="screen" style="min-height:auto">
      <NavBar
        title={existing ? 'Edit' : 'Add'}
        left={
          <button class="text-btn" onClick={() => void close()}>
            {existing ? 'Cancel' : 'Close'}
          </button>
        }
        right={
          <button class="text-btn" style="font-weight:600" onClick={save} title="Ctrl+Enter">
            {existing ? 'Save' : 'Add'}
          </button>
        }
      />
      <div class="content" style="padding-bottom:40px">
        <div class="group">
          <button
            class="row"
            disabled={!!existing}
            onClick={async () => {
              const v = await choose(
                'Note type',
                [...col.notetypes.values()].map((n) => ({ label: n.name, value: n.id })),
              );
              if (v) setNtId(v);
            }}
          >
            <div class="grow">Type</div>
            <div class="value">{nt.name}</div>
          </button>
          {!existing ? (
            <button
              class="row"
              onClick={async () => {
                const v = await choose('Deck', decks.map((d) => ({ label: d.name, value: d.id })));
                if (v) setDeckId(v);
              }}
            >
              <div class="grow">Deck</div>
              <div class="value" style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {col.decks.get(deckId)?.name}
              </div>
            </button>
          ) : (
            <div class="row static">
              <div class="grow">Cards</div>
              <div class="value">{cards.length}</div>
            </div>
          )}
        </div>

        <div class="editor-toolbar">
          <button title="Bold (Ctrl+B)" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
            <b>B</b>
          </button>
          <button title="Italic (Ctrl+I)" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
            <i>I</i>
          </button>
          <button title="Underline (Ctrl+U)" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')}>
            <u>U</u>
          </button>
          <button title="Clear formatting" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('removeFormat')}>
            T̶
          </button>
          {nt.kind === 'cloze' && (
            <>
              <button title="Cloze deletion (Ctrl+Shift+C)" onMouseDown={(e) => e.preventDefault()} onClick={() => insertCloze(false)}>
                [...]
              </button>
              <button title="Cloze, same number (Ctrl+Alt+Shift+C)" onMouseDown={(e) => e.preventDefault()} onClick={() => insertCloze(true)}>
                [..]=
              </button>
            </>
          )}
          <button style="margin-left:auto" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Hide preview' : 'Preview'}
          </button>
        </div>

        <div key={resetKey}>
          {nt.fields.map((name, i) => (
            <FieldEditor
              name={name}
              value={fields[i] ?? ''}
              autofocus={i === 0 && !existing}
              registerFocus={(el) => (focused.current = el)}
              onChange={(html) =>
                setFields((f) => {
                  const next = [...f];
                  next[i] = html;
                  return next;
                })
              }
            />
          ))}
        </div>

        <label class="field">
          <span>Tags</span>
          <TagInput tags={tags} onChange={setTags} />
        </label>

        {previewHtml && (
          <div class="group" style="padding:0">
            <div class="group-title" style="margin:10px 16px 0">Front</div>
            <CardView html={previewHtml.question} css={nt.css} />
            <div class="group-title" style="margin:10px 16px 0">Back</div>
            <CardView html={previewHtml.answer} css={nt.css} />
          </div>
        )}

        {nt.kind === 'cloze' && (
          <p class="hint-text">
            Select text and tap [...] to make a cloze deletion. Use <code>{'{{c1::text::hint}}'}</code> for hints.
          </p>
        )}
      </div>
    </div>
  );
}

export function AddScreen({ deckId }: { deckId?: number }) {
  return <NoteEditor deckId={deckId} onDone={() => history.back()} />;
}

export function EditScreen({ noteId }: { noteId: number }) {
  if (!col.notes.has(noteId)) return <div class="empty-state">Note not found.</div>;
  return <NoteEditor noteId={noteId} onDone={() => history.back()} />;
}
