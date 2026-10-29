import { useEffect, useMemo, useState } from 'preact/hooks';
import { col, navigate, toast, useCol, useRoute, downloadFile } from './state';
import { Icon, NavBar, actionSheet, choose, confirm, prompt } from './components';
import { type Card, CardState, FLAG_COLORS, FLAG_NAMES } from '../core/types';
import { SearchError } from '../core/search';
import { renderCard, stripHtml } from '../core/template';
import { formatDays } from '../core/time';
import { exportNotesText } from '../importers/csv';

type SortKey = 'added' | 'due' | 'sortField' | 'ivl' | 'ease' | 'reps' | 'lapses' | 'modified';
const SORTS: { label: string; value: SortKey }[] = [
  { label: 'Date added', value: 'added' },
  { label: 'Due', value: 'due' },
  { label: 'Sort field', value: 'sortField' },
  { label: 'Interval', value: 'ivl' },
  { label: 'Ease / difficulty', value: 'ease' },
  { label: 'Reviews', value: 'reps' },
  { label: 'Lapses', value: 'lapses' },
  { label: 'Modified', value: 'modified' },
];

const QUICK: { label: string; q: string }[] = [
  { label: 'Due', q: 'is:due' },
  { label: 'New', q: 'is:new' },
  { label: 'Learning', q: 'is:learn' },
  { label: 'Review', q: 'is:review' },
  { label: 'Suspended', q: 'is:suspended' },
  { label: 'Buried', q: 'is:buried' },
  { label: 'Marked', q: 'tag:marked' },
  { label: 'Flagged', q: '-flag:0' },
  { label: 'Leeches', q: 'tag:leech' },
  { label: 'Rated today', q: 'rated:1' },
  { label: 'Added today', q: 'added:1' },
  { label: 'Again today', q: 'rated:1:1' },
];

const PAGE = 100;

export function Browse() {
  useCol();
  const route = useRoute();
  const initial = route.query.get('q') ?? localStorage.getItem('browse.q') ?? 'deck:current';
  const [query, setQuery] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const [sort, setSort] = useState<SortKey>((localStorage.getItem('browse.sort') as SortKey) ?? 'added');
  const [desc, setDesc] = useState(localStorage.getItem('browse.desc') === '1');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [notesMode, setNotesMode] = useState(localStorage.getItem('browse.notes') === '1');

  useEffect(() => {
    const q = route.query.get('q');
    if (q !== null) {
      setQuery(q);
      setApplied(q);
    }
  }, [route.query.get('q')]);

  useEffect(() => {
    localStorage.setItem('browse.q', applied);
    localStorage.setItem('browse.sort', sort);
    localStorage.setItem('browse.desc', desc ? '1' : '0');
    localStorage.setItem('browse.notes', notesMode ? '1' : '0');
  }, [applied, sort, desc, notesMode]);

  const { cards, error } = useMemo(() => {
    try {
      let list = col.search(applied);
      if (notesMode) {
        const seen = new Set<number>();
        list = list.filter((c) => (seen.has(c.noteId) ? false : (seen.add(c.noteId), true)));
      }
      return { cards: sortCards(list, sort, desc), error: '' };
    } catch (e) {
      return { cards: [] as Card[], error: e instanceof SearchError || e instanceof SyntaxError ? e.message : String(e) };
    }
  }, [applied, sort, desc, notesMode, col.version]);

  const run = (q: string) => {
    setQuery(q);
    setApplied(q);
    setLimit(PAGE);
    setSelected(new Set());
  };

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const ids = [...selected];
  const noteIds = () => [...new Set(ids.map((id) => col.cards.get(id)?.noteId).filter((x): x is number => !!x))];

  const bulk = async () => {
    await actionSheet(`${ids.length} selected`, [
      { label: 'Select all', run: () => setSelected(new Set(cards.map((c) => c.id))) },
      { label: 'Toggle suspend', run: () => col.setSuspended(ids, !ids.every((id) => col.cards.get(id)?.suspended)) },
      { label: 'Bury', run: () => col.bury(ids) },
      { label: 'Unbury', run: () => col.unbury(ids) },
      {
        label: 'Flag…',
        run: async () => {
          const f = await choose('Flag', FLAG_NAMES.map((label, value) => ({ label, value })));
          if (f !== null) col.setFlag(ids, f);
        },
      },
      {
        label: 'Change deck…',
        run: async () => {
          const d = await choose(
            'Move to deck',
            col.sortedDecks().filter((x) => !x.dyn).map((x) => ({ label: x.name, value: x.id })),
          );
          if (d) col.setDeck(ids, d);
        },
      },
      {
        label: 'Add tags…',
        run: async () => {
          const t = await prompt('Add tags', '', { placeholder: 'space separated' });
          if (t?.trim()) col.addTags(noteIds(), t.split(/\s+/));
        },
      },
      {
        label: 'Remove tags…',
        run: async () => {
          const t = await prompt('Remove tags', '', { placeholder: 'space separated' });
          if (t?.trim()) col.removeTags(noteIds(), t.split(/\s+/));
        },
      },
      { label: 'Toggle mark', run: () => noteIds().forEach((n) => col.toggleMark(n)) },
      {
        label: 'Set due date…',
        run: async () => {
          const v = await prompt('Set due date', '0', { message: 'Days from today. Use a range like 1-7 to spread.', ok: 'Set' });
          if (v === null) return;
          const m = /^(\d+)(?:-(\d+))?$/.exec(v.trim());
          if (!m) return toast('Enter a number or a range like 1-7');
          const lo = Number(m[1]);
          const hi = Number(m[2] ?? m[1]);
          const groups = new Map<number, number[]>();
          for (const id of ids) {
            const d = lo + Math.floor(Math.random() * (hi - lo + 1));
            groups.set(d, [...(groups.get(d) ?? []), id]);
          }
          col.transact('Set due date', () => groups.forEach((g, d) => col.setDueDate(g, d)));
        },
      },
      {
        label: 'Reposition new cards…',
        run: async () => {
          const v = await prompt('Start position', '1', { type: 'number', message: 'New cards are placed in order starting here, shifting others.' });
          if (v !== null) col.repositionNew(ids, Math.max(0, Number(v)), 1, true);
        },
      },
      { label: 'Reset to new (forget)', run: () => col.forget(ids) },
      {
        label: 'Create filtered deck from selection',
        run: () => {
          const d = col.createFiltered('Filtered Deck', {
            search: `cid:${ids.join(',')}`,
            limit: ids.length,
            order: 'due',
            reschedule: true,
          });
          navigate(`study/${d.id}`);
        },
      },
      {
        label: 'Export notes (.txt)',
        run: () => downloadFile('notes.txt', exportNotesText(col, ids), 'text/plain'),
      },
      {
        label: `Delete ${noteIds().length} note(s)`,
        destructive: true,
        run: async () => {
          if (!(await confirm('Delete notes?', `${noteIds().length} note(s) and all their cards will be deleted.`, 'Delete', true))) return;
          col.deleteNotes(noteIds());
          setSelected(new Set());
          toast('Deleted', { label: 'Undo', run: () => col.undo() });
        },
      },
    ]);
  };

  return (
    <div class="screen">
      <NavBar
        title={`Browse (${cards.length}${notesMode ? ' notes' : ''})`}
        left={
          <button class="text-btn" onClick={() => (setSelecting(!selecting), setSelected(new Set()))}>
            {selecting ? 'Done' : 'Select'}
          </button>
        }
        right={
          <>
            <button
              class="icon-btn"
              aria-label="Sort"
              onClick={async () => {
                const v = await choose<SortKey | 'dir' | 'mode'>('Sort by', [
                  ...SORTS.map((s) => ({ label: `${s.value === sort ? '✓ ' : ''}${s.label}`, value: s.value })),
                  { label: desc ? 'Ascending order' : 'Descending order', value: 'dir' },
                  { label: notesMode ? 'Show cards' : 'Show notes', value: 'mode' },
                ]);
                if (v === 'dir') setDesc(!desc);
                else if (v === 'mode') setNotesMode(!notesMode);
                else if (v) setSort(v);
              }}
            >
              <Icon name="sort" />
            </button>
            <button class="icon-btn" aria-label="Search help" onClick={() => navigate('help/search')}>
              <Icon name="info" />
            </button>
          </>
        }
      />
      <form
        class="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <input
          type="search"
          value={query}
          placeholder="Search (Anki syntax: deck:, tag:, is:due, prop:ivl>10…)"
          aria-label="Search"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </form>
      {error && <div class="search-error">{error}</div>}
      <div class="chips">
        <button class={`chip ${applied === '' ? 'on' : ''}`} onClick={() => run('')}>
          All
        </button>
        <button class={`chip ${applied === 'deck:current' ? 'on' : ''}`} onClick={() => run('deck:current')}>
          Current deck
        </button>
        {QUICK.map((q) => (
          <button class={`chip ${applied === q.q ? 'on' : ''}`} onClick={() => run(q.q)}>
            {q.label}
          </button>
        ))}
        <button
          class="chip"
          onClick={async () => {
            const d = await choose('Deck', col.sortedDecks().map((x) => ({ label: x.name, value: x.name })));
            if (d) run(`deck:"${d}"`);
          }}
        >
          Deck…
        </button>
        <button
          class="chip"
          onClick={async () => {
            const tags = [...col.allTags().keys()];
            if (!tags.length) return toast('No tags yet');
            const t = await choose('Tag', tags.map((x) => ({ label: x, value: x })));
            if (t) run(`tag:${t}`);
          }}
        >
          Tag…
        </button>
      </div>
      <div class="content flush" style="padding-top:0">
        <div class="group card-list" style="border-radius:0">
          {cards.slice(0, limit).map((c) => (
            <CardRow
              card={c}
              selecting={selecting}
              selected={selected.has(c.id)}
              onClick={() => (selecting ? toggle(c.id) : navigate(`edit/${c.noteId}`))}
              onLong={() => {
                setSelecting(true);
                toggle(c.id);
              }}
            />
          ))}
          {!cards.length && !error && <div class="empty-state">No cards match.</div>}
        </div>
        {cards.length > limit && (
          <div class="load-more">
            <button class="btn" onClick={() => setLimit(limit + PAGE * 3)}>
              Show more ({cards.length - limit} left)
            </button>
          </div>
        )}
      </div>
      {selecting && selected.size > 0 && (
        <div class="bulk-bar">
          <div class="inner">
            <button class="btn small" onClick={() => col.setSuspended(ids, !ids.every((id) => col.cards.get(id)?.suspended))}>
              Suspend
            </button>
            <button class="btn small" onClick={() => void bulk()}>
              Actions ({selected.size})
            </button>
            <button class="btn small" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CardRow(props: { card: Card; selecting: boolean; selected: boolean; onClick: () => void; onLong: () => void }) {
  const c = props.card;
  const note = col.notes.get(c.noteId);
  const nt = note && col.notetypes.get(note.notetypeId);
  if (!note || !nt) return null;
  const q = stripHtml(renderCard(nt, note.fields, c.ord, { tags: note.tags, deck: '' }).question)
    .replace(/\s+/g, ' ')
    .trim();
  const a = stripHtml(note.fields[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const deck = col.decks.get(c.deckId);
  let due = '';
  if (c.suspended) due = 'Suspended';
  else if (c.state === CardState.New) due = `New #${c.due}`;
  else {
    const d = col.dueDay(c)! - col.today;
    due = d <= 0 ? 'Due' : `Due in ${formatDays(d)}`;
  }
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  return (
    <button
      class={`row ${props.selected ? 'selected' : ''} ${c.suspended ? 'suspended' : ''}`}
      onClick={props.onClick}
      onPointerDown={() => (pressTimer = setTimeout(props.onLong, 550))}
      onPointerUp={() => clearTimeout(pressTimer)}
      onPointerLeave={() => clearTimeout(pressTimer)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onLong();
      }}
    >
      {props.selecting && <span class={`select-box ${props.selected ? 'on' : ''}`}>{props.selected ? '✓' : ''}</span>}
      {c.flag > 0 && <span class="flag-dot" style={{ background: FLAG_COLORS[c.flag] }} />}
      <div class="grow">
        <div class="q">{q || '(empty)'}</div>
        {a && <div class="sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{a}</div>}
        <div class="meta">
          <span>{deck?.name.split('::').pop()}</span>
          <span>{due}</span>
          {c.state !== CardState.New && <span>ivl {formatDays(c.ivl)}</span>}
          {c.lapses > 0 && <span>{c.lapses} lapses</span>}
          {note.tags.includes('marked') && <span>★</span>}
        </div>
      </div>
    </button>
  );
}

function sortCards(list: Card[], key: SortKey, desc: boolean): Card[] {
  const sortField = (c: Card) => {
    const n = col.notes.get(c.noteId);
    const nt = n && col.notetypes.get(n.notetypeId);
    return stripHtml(n?.fields[nt?.sortField ?? 0] ?? '').toLowerCase();
  };
  const dueKey = (c: Card) => (c.state === CardState.New ? 1e9 + c.due : (col.dueDay(c) ?? 0));
  const getters: Record<SortKey, (c: Card) => number | string> = {
    added: (c) => c.noteId * 100 + c.ord,
    due: dueKey,
    sortField,
    ivl: (c) => c.ivl,
    ease: (c) => (col.settings.scheduler === 'fsrs' ? c.difficulty ?? 0 : c.ease),
    reps: (c) => c.reps,
    lapses: (c) => c.lapses,
    modified: (c) => c.mod,
  };
  const g = getters[key];
  const decorated = list.map((c) => [g(c), c] as const);
  decorated.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (desc) decorated.reverse();
  return decorated.map((d) => d[1]);
}

export function SearchHelp() {
  const rows: [string, string][] = [
    ['dog cat', 'notes containing both words'],
    ['dog or cat', 'either word'],
    ['-cat', 'without “cat”'],
    ['"a phrase"', 'exact phrase'],
    ['d*g, d_g', 'wildcards (any text, one character)'],
    ['front:dog', 'field “Front” is exactly dog (use * for partial)'],
    ['deck:French', 'deck and its subdecks; deck:current, deck:filtered'],
    ['tag:verb', 'tag and child tags; tag:none'],
    ['is:due / is:new / is:learn / is:review', 'card state'],
    ['is:suspended / is:buried / is:marked / is:leech', ''],
    ['flag:1 … flag:7', 'red, orange, green, blue, pink, turquoise, purple; flag:0 = none'],
    ['rated:7, rated:7:1', 'answered in the last 7 days (with Again)'],
    ['introduced:3, added:3, edited:3', 'first studied / added / edited recently'],
    ['prop:ivl>=30', 'also due, reps, lapses, ease, pos, s, d, r'],
    ['prop:due=1', 'due tomorrow; prop:due<0 = overdue'],
    ['note:Basic, card:2', 'note type / card template'],
    ['nid:123, cid:1,2', 'by id'],
    ['re:^\\d+$, w:word', 'regex / whole word'],
  ];
  return (
    <div class="screen">
      <NavBar title="Search Syntax" backTo="browse" />
      <div class="content">
        <div class="stat-card">
          <table class="simple">
            <tbody>
              {rows.map(([k, v]) => (
                <tr>
                  <td style="text-align:left;white-space:nowrap">
                    <code>{k}</code>
                  </td>
                  <td style="text-align:left" class="muted">
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="hint-text">Terms are combined with AND. Group with parentheses: <code>(dog or cat) -tag:pets</code></p>
      </div>
    </div>
  );
}
