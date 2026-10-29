import { useState } from 'preact/hooks';
import { col, navigate, toast, useCol } from './state';
import { NavBar, NumberRow, SelectRow, SwitchRow, Row } from './components';
import type { FilteredOrder, FilteredSpec } from '../core/types';
import { compileSearch } from '../core/search';

const ORDERS: { label: string; value: FilteredOrder }[] = [
  { label: 'Random', value: 'random' },
  { label: 'Due date', value: 'due' },
  { label: 'Order added', value: 'added' },
  { label: 'Increasing intervals', value: 'ivlAsc' },
  { label: 'Decreasing intervals', value: 'ivlDesc' },
  { label: 'Most lapses', value: 'lapses' },
  { label: 'Lowest retrievability', value: 'retrievability' },
];

export function FilteredDeckEditor({ deckId }: { deckId?: number }) {
  useCol();
  const existing = deckId ? col.decks.get(deckId) : undefined;
  const current = col.settings.currentDeckId ? col.decks.get(col.settings.currentDeckId) : undefined;
  const [name, setName] = useState(existing?.name ?? 'Filtered Deck 1');
  const [spec, setSpec] = useState<FilteredSpec>(
    existing?.dyn ?? {
      search: current && !current.dyn ? `deck:"${current.name}" is:due` : 'is:due',
      limit: 100,
      order: 'random',
      reschedule: true,
    },
  );
  let error = '';
  try {
    if (spec.search.trim()) compileSearch(spec.search, col.searchEnv());
  } catch (e) {
    error = (e as Error).message;
  }

  const save = () => {
    if (error) return toast(error);
    if (existing) {
      col.saveDeck({ ...existing, dyn: spec });
      if (name !== existing.name) col.renameDeck(existing.id, name);
      const n = col.rebuildFiltered(existing.id);
      toast(`${n} cards gathered`);
      navigate(`study/${existing.id}`, true);
    } else {
      const d = col.createFiltered(name.trim() || 'Filtered Deck', spec);
      const n = col.cards.size ? [...col.cards.values()].filter((c) => c.deckId === d.id).length : 0;
      if (!n) toast('No cards matched. The deck was created empty.');
      navigate(`study/${d.id}`, true);
    }
  };

  return (
    <div class="screen">
      <NavBar
        title={existing ? 'Filtered Deck' : 'New Filtered Deck'}
        backTo=""
        right={
          <button class="text-btn" style="font-weight:600" onClick={save}>
            {existing ? 'Rebuild' : 'Build'}
          </button>
        }
      />
      <div class="content">
        <label class="field">
          <span>Name</span>
          <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Search</span>
          <input
            type="text"
            value={spec.search}
            autocapitalize="off"
            onInput={(e) => setSpec({ ...spec, search: (e.target as HTMLInputElement).value })}
          />
          {error ? <div class="search-error" style="padding:6px 4px 0">{error}</div> : <div class="hint-text">Anki search syntax, e.g. deck:Spanish is:due, tag:verb, rated:1:1</div>}
        </label>
        <div class="group">
          <NumberRow label="Limit" value={spec.limit} min={1} max={99999} onChange={(limit) => setSpec({ ...spec, limit })} />
          <SelectRow label="Order" value={spec.order} options={ORDERS} onChange={(order) => setSpec({ ...spec, order })} />
          <SwitchRow
            label="Reschedule cards based on my answers"
            sub="Off = preview mode: answers don't affect scheduling"
            checked={spec.reschedule}
            onChange={(reschedule) => setSpec({ ...spec, reschedule })}
          />
        </div>
        <p class="hint-text">Suspended, buried and cards already in another filtered deck are not included.</p>
      </div>
    </div>
  );
}

export function CustomStudy({ deckId }: { deckId: number }) {
  useCol();
  const deck = col.decks.get(deckId);
  const [newExtra, setNewExtra] = useState(10);
  const [revExtra, setRevExtra] = useState(50);
  const [days, setDays] = useState(1);
  const [ahead, setAhead] = useState(1);
  if (!deck) return <div class="empty-state">Deck not found.</div>;
  const q = `deck:"${deck.name}"`;
  const build = (name: string, spec: FilteredSpec) => {
    const d = col.createFiltered(name, spec);
    const n = [...col.cards.values()].filter((c) => c.deckId === d.id).length;
    if (!n) {
      col.deleteDeck(d.id);
      return toast('No cards matched those criteria');
    }
    navigate(`study/${d.id}`, true);
  };
  return (
    <div class="screen">
      <NavBar title="Custom Study" backTo="" />
      <div class="content">
        <p class="center muted" style="margin:0 0 12px">{deck.name}</p>
        <div class="group">
          <NumberRow label="Increase today's new card limit by" value={newExtra} min={1} max={9999} onChange={setNewExtra} />
          <Row
            onClick={() => {
              col.extendLimits(deckId, newExtra, 0);
              navigate(`study/${deckId}`, true);
            }}
          >
            <span style="color:var(--accent)">Study more new cards</span>
          </Row>
        </div>
        <div class="group">
          <NumberRow label="Increase today's review limit by" value={revExtra} min={1} max={99999} onChange={setRevExtra} />
          <Row
            onClick={() => {
              col.extendLimits(deckId, 0, revExtra);
              navigate(`study/${deckId}`, true);
            }}
          >
            <span style="color:var(--accent)">Study more reviews</span>
          </Row>
        </div>
        <div class="group">
          <NumberRow label="Review cards forgotten in the last N days" value={days} min={1} max={365} onChange={setDays} />
          <Row onClick={() => build('Custom Study Session', { search: `${q} rated:${days}:1`, limit: 9999, order: 'random', reschedule: true })}>
            <span style="color:var(--accent)">Review forgotten cards</span>
          </Row>
        </div>
        <div class="group">
          <NumberRow label="Review ahead by N days" value={ahead} min={1} max={365} onChange={setAhead} />
          <Row
            onClick={() =>
              build('Custom Study Session', { search: `${q} prop:due<=${ahead} -is:new -is:suspended`, limit: 9999, order: 'due', reschedule: true })
            }
          >
            <span style="color:var(--accent)">Review ahead</span>
          </Row>
        </div>
        <div class="group">
          <Row onClick={() => build('Custom Study Session', { search: `${q} is:new`, limit: 100, order: 'added', reschedule: false })}>
            <span style="color:var(--accent)">Preview new cards</span>
          </Row>
          <Row onClick={() => build('Custom Study Session', { search: `${q} -is:new -is:suspended`, limit: 100, order: 'random', reschedule: false })}>
            <span style="color:var(--accent)">Cram (random, no rescheduling)</span>
          </Row>
          <Row onClick={() => build('Custom Study Session', { search: `${q} -is:new prop:r<0.8`, limit: 100, order: 'retrievability', reschedule: true })}>
            <span style="color:var(--accent)">Weakest cards (lowest retrievability)</span>
          </Row>
          <Row onClick={() => navigate('filtered/new')}>
            <span style="color:var(--accent)">Custom search…</span>
          </Row>
        </div>
      </div>
    </div>
  );
}
