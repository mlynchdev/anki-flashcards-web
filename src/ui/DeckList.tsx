import { col, downloadFile, navigate, toast, useCol } from './state';
import { Icon, NavBar, actionSheet, confirm, prompt } from './components';
import type { Counts, DeckNode } from '../core/collection';
import { makeBackup } from '../importers/backup';
import { exportNotesText } from '../importers/csv';
import { formatInterval } from '../core/time';

function CountsView({ c }: { c: Counts }) {
  return (
    <div class="counts">
      <span class={c.new ? 'c-new' : 'c-zero'}>{c.new}</span>
      <span class={c.learn ? 'c-learn' : 'c-zero'}>{c.learn}</span>
      <span class={c.review ? 'c-review' : 'c-zero'}>{c.review}</span>
    </div>
  );
}

export async function deckMenu(node: DeckNode) {
  const d = node.deck;
  const safeName = d.name.replace(/[^\w.-]+/g, '_');
  await actionSheet(d.name, [
    { label: 'Study', run: () => navigate(`study/${d.id}`) },
    { label: 'Rebuild', run: () => toast(`${col.rebuildFiltered(d.id)} cards gathered`), hidden: !d.dyn },
    { label: 'Empty', run: () => col.emptyFiltered(d.id), hidden: !d.dyn },
    { label: 'Edit filtered deck', run: () => navigate(`filtered/${d.id}`), hidden: !d.dyn },
    { label: 'Options', run: () => navigate(`options/${d.id}`), hidden: !!d.dyn },
    { label: 'Custom Study', run: () => navigate(`custom-study/${d.id}`), hidden: !!d.dyn },
    { label: 'Browse cards', run: () => navigate(`browse?q=${encodeURIComponent(`deck:"${d.name}"`)}`) },
    { label: 'Add note here', run: () => navigate(`add?deck=${d.id}`), hidden: !!d.dyn },
    {
      label: 'Add subdeck',
      hidden: !!d.dyn,
      run: async () => {
        const name = await prompt('New subdeck', '', { placeholder: 'Name', ok: 'Add' });
        if (name?.trim()) col.getOrCreateDeck(`${d.name}::${name}`);
      },
    },
    {
      label: 'Rename',
      run: async () => {
        const name = await prompt('Rename deck', d.name, { message: 'Use :: to nest decks, e.g. Parent::Child', ok: 'Rename' });
        if (!name) return;
        try {
          col.renameDeck(d.id, name);
        } catch (e) {
          toast((e as Error).message);
        }
      },
    },
    { label: 'Unbury', run: () => col.unburyDeck(d.id), hidden: !!d.dyn },
    {
      label: 'Export deck (backup .json)',
      run: async () => {
        const ids = new Set(col.deckAndChildren(d.id).map((x) => x.id));
        const b = await makeBackup(col, { deckIds: ids });
        downloadFile(`${safeName}.json`, JSON.stringify(b), 'application/json');
      },
    },
    {
      label: 'Export notes (.txt)',
      run: () => {
        const ids = new Set(col.deckAndChildren(d.id).map((x) => x.id));
        const cards = [...col.cards.values()].filter((c) => ids.has(c.deckId) || (c.odid !== undefined && ids.has(c.odid)));
        downloadFile(`${safeName}.txt`, exportNotesText(col, cards.map((c) => c.id)), 'text/plain');
      },
    },
    {
      label: 'Delete',
      destructive: true,
      run: async () => {
        const msg = d.dyn
          ? 'Cards will return to their original decks.'
          : `This deletes the deck and its ${node.total} card${node.total === 1 ? '' : 's'}.`;
        if (await confirm(`Delete “${node.label}”?`, msg, 'Delete', true)) {
          col.deleteDeck(d.id);
          toast('Deck deleted', { label: 'Undo', run: () => col.undo() });
        }
      },
    },
  ]);
}

function DeckRows({ nodes }: { nodes: DeckNode[] }) {
  return (
    <>
      {nodes.map((n) => (
        <>
          <div class="deck-row" style={{ paddingLeft: `${n.depth * 18}px` }}>
            {n.children.length ? (
              <button
                class={`twisty ${n.deck.collapsed ? '' : 'open'}`}
                aria-label={n.deck.collapsed ? 'Expand' : 'Collapse'}
                onClick={() => col.setDeckCollapsed(n.deck.id, !n.deck.collapsed)}
              >
                <Icon name="chevron" />
              </button>
            ) : (
              <span class="twisty" />
            )}
            <button
              class={`name ${n.deck.dyn ? 'filtered' : ''}`}
              onClick={() => navigate(`study/${n.deck.id}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                void deckMenu(n);
              }}
            >
              <span class="title">{n.label}</span>
            </button>
            <CountsView c={n.counts} />
            <button class="icon-btn more" aria-label={`${n.label} options`} onClick={() => void deckMenu(n)}>
              <Icon name="more" />
            </button>
          </div>
          {!n.deck.collapsed && n.children.length > 0 && <DeckRows nodes={n.children} />}
        </>
      ))}
    </>
  );
}

export function DeckList() {
  useCol();
  const tree = col.deckTree();
  const empty = col.cards.size === 0;
  const today = col.today;
  const startOfToday = col.dayStart(today);
  let studied = 0;
  let ms = 0;
  for (const r of col.revlog.values()) {
    if (r.id >= startOfToday && r.ease > 0) {
      studied++;
      ms += r.time;
    }
  }

  const addMenu = () =>
    actionSheet(undefined, [
      {
        label: 'Create deck',
        run: async () => {
          const name = await prompt('New deck', '', { placeholder: 'Deck name (use :: for subdecks)', ok: 'Create' });
          if (name?.trim()) col.getOrCreateDeck(name);
        },
      },
      { label: 'Create filtered deck', run: () => navigate('filtered/new') },
      { label: 'Import file', run: () => navigate('import') },
    ]);

  return (
    <div class="screen">
      <NavBar
        title="Decks"
        left={
          <button class="icon-btn" onClick={() => navigate('import')} aria-label="Import">
            <Icon name="import" />
          </button>
        }
        right={
          <button class="icon-btn" onClick={() => void addMenu()} aria-label="Add deck">
            <Icon name="add" />
          </button>
        }
      />
      <div class="content">
        {empty ? (
          <div class="empty-state">
            <h2>No cards yet</h2>
            <p>
              Import an Anki package (.apkg / .colpkg), a card store (.db), a backup or a CSV file, or start adding
              notes. Everything stays in this browser.
            </p>
            <div class="row-actions" style="justify-content:center">
              <button class="btn primary" onClick={() => navigate('import')}>
                Import
              </button>
              <button class="btn" onClick={() => navigate('add')}>
                Add a note
              </button>
            </div>
          </div>
        ) : (
          <>
            <p class="today-line">
              {studied
                ? `Studied ${studied} card${studied === 1 ? '' : 's'} in ${formatInterval(ms / 1000)} today`
                : 'Tap a deck to study'}
            </p>
            <div class="group" style="padding-left:4px">
              <DeckRows nodes={tree} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
