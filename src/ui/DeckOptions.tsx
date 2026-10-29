import { useState } from 'preact/hooks';
import { col, toast, useCol, navigate } from './state';
import { NavBar, NumberRow, Row, SelectRow, SwitchRow, choose, confirm, prompt } from './components';
import type { DeckConfig } from '../core/types';
import { DEFAULT_CONFIG_ID } from '../core/collection';
import { DEFAULT_W, normalizeWeights } from '../core/fsrs';

function StepsRow(props: { label: string; sub?: string; value: number[]; onChange: (v: number[]) => void }) {
  const fmt = (v: number[]) => v.map((m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join(' ');
  const [text, setText] = useState(fmt(props.value));
  const [err, setErr] = useState(false);
  const commit = () => {
    const parts = text.trim().split(/[\s,]+/).filter(Boolean);
    const out: number[] = [];
    for (const p of parts) {
      const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(p);
      if (!m) return setErr(true);
      const n = Number(m[1]);
      const unit = m[2].toLowerCase() || 'm';
      out.push(unit === 's' ? n / 60 : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n);
    }
    setErr(false);
    props.onChange(out);
    setText(fmt(out));
  };
  return (
    <div class="row static">
      <div class="grow">
        <div>{props.label}</div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      <input
        type="text"
        style={{ width: '130px', minHeight: '36px', padding: '6px 10px', textAlign: 'right', borderColor: err ? 'var(--danger)' : undefined }}
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </div>
  );
}

export function DeckOptions({ deckId }: { deckId: number }) {
  useCol();
  const deck = col.decks.get(deckId);
  const [optimizing, setOptimizing] = useState<number | null>(null);
  if (!deck) return <div class="empty-state">Deck not found.</div>;
  const conf = col.configFor(deckId);
  const users = [...col.decks.values()].filter((d) => d.configId === conf.id).length;
  const set = (patch: Partial<DeckConfig>) => col.saveConfig({ ...conf, ...patch });
  const fsrs = col.settings.scheduler === 'fsrs';

  const optimize = async () => {
    const ids = new Set(
      [...col.decks.values()].filter((d) => d.configId === conf.id).flatMap((d) => col.deckAndChildren(d.id).map((x) => x.id)),
    );
    const cardIds = new Set([...col.cards.values()].filter((c) => ids.has(c.odid ?? c.deckId)).map((c) => c.id));
    const revlog = [...col.revlog.values()].filter((r) => cardIds.has(r.cardId));
    setOptimizing(0);
    try {
      const { runOptimizer } = await import('../core/optimizerClient');
      const res = await runOptimizer(revlog, col.settings.rolloverHour, normalizeWeights(conf.fsrsParams), (f) => setOptimizing(f));
      set({ fsrsParams: res.w });
      toast(`Optimized on ${res.reviews} reviews · log loss ${res.before.toFixed(4)} → ${res.after.toFixed(4)}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setOptimizing(null);
    }
  };

  return (
    <div class="screen">
      <NavBar title="Deck Options" backTo="" />
      <div class="content">
        <p class="center muted" style="margin:0 0 12px">{deck.name}</p>
        <div class="group-title">Preset</div>
        <div class="group">
          <button
            class="row"
            onClick={async () => {
              const v = await choose(
                'Preset',
                [...col.configs.values()].map((c) => ({ label: `${c.id === conf.id ? '✓ ' : ''}${c.name}`, value: c.id })),
              );
              if (v) col.setDeckConfig(deckId, v);
            }}
          >
            <div class="grow">
              {conf.name}
              <div class="sub">Used by {users} deck{users === 1 ? '' : 's'}</div>
            </div>
            <span class="value">Change</span>
          </button>
          <Row
            onClick={async () => {
              const name = await prompt('New preset', `${conf.name} copy`, { ok: 'Add' });
              if (!name) return;
              const c = col.addConfig(name, conf);
              col.setDeckConfig(deckId, c.id);
            }}
          >
            Clone preset
          </Row>
          <Row
            onClick={async () => {
              const name = await prompt('Rename preset', conf.name, { ok: 'Rename' });
              if (name) set({ name });
            }}
          >
            Rename preset
          </Row>
          <Row onClick={() => col.setDeckConfig(deckId, conf.id, true)}>Apply to all subdecks</Row>
          {conf.id !== DEFAULT_CONFIG_ID && (
            <Row
              class="danger"
              onClick={async () => {
                if (await confirm('Remove preset?', 'Decks using it switch to Default.', 'Remove', true)) col.removeConfig(conf.id);
              }}
            >
              <span style="color:var(--danger)">Remove preset</span>
            </Row>
          )}
        </div>

        <div class="group-title">Daily limits</div>
        <div class="group">
          <NumberRow label="New cards/day" value={conf.newPerDay} min={0} max={9999} onChange={(newPerDay) => set({ newPerDay })} />
          <NumberRow label="Maximum reviews/day" value={conf.revPerDay} min={0} max={99999} onChange={(revPerDay) => set({ revPerDay })} />
        </div>

        <div class="group-title">New cards</div>
        <div class="group">
          <StepsRow label="Learning steps" sub="e.g. 1m 10m, or 10m 1d" value={conf.learnSteps} onChange={(learnSteps) => set({ learnSteps })} />
          {!fsrs && (
            <>
              <NumberRow label="Graduating interval (days)" value={conf.graduatingIvl} min={1} onChange={(graduatingIvl) => set({ graduatingIvl })} />
              <NumberRow label="Easy interval (days)" value={conf.easyIvl} min={1} onChange={(easyIvl) => set({ easyIvl })} />
            </>
          )}
          <SelectRow
            label="Insertion order"
            value={conf.newOrder}
            options={[
              { label: 'Sequential', value: 'due' },
              { label: 'Random', value: 'random' },
            ]}
            onChange={(newOrder) => set({ newOrder })}
          />
          <SelectRow
            label="New card gather order"
            sub="When studying this deck: take subdecks one at a time, or shuffle all subdecks together"
            value={conf.newGather ?? 'deck'}
            options={[
              { label: 'Deck', value: 'deck' },
              { label: 'Random cards', value: 'random' },
            ]}
            onChange={(newGather) => set({ newGather })}
          />
          <SelectRow
            label="Review sort order"
            value={conf.reviewSort ?? 'due'}
            options={[
              { label: 'Due date', value: 'due' },
              { label: 'Random (across subdecks)', value: 'random' },
            ]}
            onChange={(reviewSort) => set({ reviewSort })}
          />
          <SelectRow
            label="New/review order"
            value={conf.newMix}
            options={[
              { label: 'Mix with reviews', value: 'mix' },
              { label: 'Show after reviews', value: 'after' },
              { label: 'Show before reviews', value: 'before' },
            ]}
            onChange={(newMix) => set({ newMix })}
          />
        </div>

        <div class="group-title">Lapses</div>
        <div class="group">
          <StepsRow label="Relearning steps" value={conf.relearnSteps} onChange={(relearnSteps) => set({ relearnSteps })} />
          {!fsrs && (
            <>
              <NumberRow label="Minimum interval" value={conf.minIvl} min={1} onChange={(minIvl) => set({ minIvl })} />
              <NumberRow label="New interval (× old)" value={conf.lapseMult} min={0} max={1} step={0.05} onChange={(lapseMult) => set({ lapseMult })} />
            </>
          )}
          <NumberRow label="Leech threshold (lapses)" value={conf.leechThreshold} min={1} onChange={(leechThreshold) => set({ leechThreshold })} />
          <SelectRow
            label="Leech action"
            value={conf.leechAction}
            options={[
              { label: 'Tag only', value: 'tag' },
              { label: 'Suspend card', value: 'suspend' },
            ]}
            onChange={(leechAction) => set({ leechAction })}
          />
        </div>

        <div class="group-title">Burying</div>
        <div class="group">
          <SwitchRow label="Bury new siblings" checked={conf.buryNew} onChange={(buryNew) => set({ buryNew })} />
          <SwitchRow label="Bury review siblings" checked={conf.buryReview} onChange={(buryReview) => set({ buryReview })} />
          <SwitchRow label="Bury interday learning siblings" checked={conf.buryInterday} onChange={(buryInterday) => set({ buryInterday })} />
        </div>

        {fsrs ? (
          <>
            <div class="group-title">FSRS</div>
            <div class="group">
              <NumberRow
                label="Desired retention"
                sub={`Lower = fewer reviews, more forgetting. ${Math.round(conf.desiredRetention * 100)}%`}
                value={conf.desiredRetention}
                min={0.7}
                max={0.99}
                step={0.01}
                onChange={(desiredRetention) => set({ desiredRetention })}
              />
              <NumberRow label="Maximum interval (days)" value={conf.maxIvl} min={1} max={36500} onChange={(maxIvl) => set({ maxIvl })} />
              <div class="row static" style="display:block">
                <div class="sub" style="margin-bottom:6px">Parameters {conf.fsrsParams.length ? '' : '(defaults)'}</div>
                <textarea
                  style="min-height:70px;font-family:ui-monospace,monospace;font-size:12px"
                  value={normalizeWeights(conf.fsrsParams).join(', ')}
                  onChange={(e) => {
                    const v = (e.target as HTMLTextAreaElement).value.split(/[\s,]+/).filter(Boolean).map(Number);
                    if (v.length && ![17, 19, 21].includes(v.length)) return toast('Expected 17, 19 or 21 numbers');
                    set({ fsrsParams: v.length ? normalizeWeights(v) : [] });
                  }}
                />
              </div>
              <button class="row" disabled={optimizing !== null} onClick={() => void optimize()}>
                <div class="grow">
                  {optimizing !== null ? `Optimizing… ${Math.round(optimizing * 100)}%` : 'Optimize parameters'}
                  <div class="sub">Fits FSRS to this preset's review history (runs locally)</div>
                  {optimizing !== null && (
                    <div class="progress" style="margin-top:8px">
                      <div style={{ width: `${optimizing * 100}%` }} />
                    </div>
                  )}
                </div>
              </button>
              <Row onClick={() => set({ fsrsParams: [] })}>
                <span>Reset parameters to defaults</span>
              </Row>
            </div>
            <p class="group-footer">Default parameters: FSRS-6 ({DEFAULT_W.length} weights).</p>
          </>
        ) : (
          <>
            <div class="group-title">Advanced (SM-2)</div>
            <div class="group">
              <NumberRow label="Maximum interval (days)" value={conf.maxIvl} min={1} max={36500} onChange={(maxIvl) => set({ maxIvl })} />
              <NumberRow label="Starting ease" value={conf.startingEase} min={1.31} max={5} step={0.05} onChange={(startingEase) => set({ startingEase })} />
              <NumberRow label="Easy bonus" value={conf.easyBonus} min={1} max={5} step={0.05} onChange={(easyBonus) => set({ easyBonus })} />
              <NumberRow label="Interval modifier" value={conf.ivlModifier} min={0.5} max={2} step={0.05} onChange={(ivlModifier) => set({ ivlModifier })} />
              <NumberRow label="Hard interval" value={conf.hardFactor} min={0.5} max={2} step={0.05} onChange={(hardFactor) => set({ hardFactor })} />
            </div>
          </>
        )}
        <p class="center">
          <button class="text-btn" onClick={() => navigate('settings')}>
            Scheduler: {fsrs ? 'FSRS' : 'SM-2'} (change in Settings)
          </button>
        </p>
      </div>
    </div>
  );
}

export function Presets() {
  useCol();
  return (
    <div class="screen">
      <NavBar title="Presets" backTo="settings" />
      <div class="content">
        <div class="group">
          {[...col.configs.values()].map((c) => {
            const decks = [...col.decks.values()].filter((d) => d.configId === c.id && !d.dyn);
            return (
              <Row
                sub={`${c.newPerDay} new · ${c.revPerDay} reviews · ${decks.length} deck(s)`}
                chevron
                onClick={() => {
                  const d = decks[0];
                  if (d) navigate(`options/${d.id}`);
                  else toast('No deck uses this preset');
                }}
              >
                {c.name}
              </Row>
            );
          })}
        </div>
      </div>
    </div>
  );
}
