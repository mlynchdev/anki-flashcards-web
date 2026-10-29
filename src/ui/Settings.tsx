import { col, navigate, toast, useCol, applyTheme } from './state';
import { NavBar, NumberRow, Row, SelectRow, SwitchRow, confirm } from './components';
import type { GestureAction, Settings as S } from '../core/types';
import { reloadServerContent, syncClient, useSyncStatus } from './sync';

function SyncGroup() {
  const st = useSyncStatus();
  if (st.state === 'disabled') {
    return (
      <>
        <div class="group-title">Sync</div>
        <div class="group">
          <Row sub="Served without the sync API (static hosting or local dev). Data lives only in this browser.">Local only</Row>
        </div>
      </>
    );
  }
  const label: Record<string, string> = {
    idle: 'Up to date',
    syncing: 'Syncing…',
    offline: 'Offline — changes are kept and sent later',
    auth: 'Sign-in required',
    error: 'Sync error',
  };
  return (
    <>
      <div class="group-title">Sync</div>
      <div class="group">
        <Row
          sub={[st.email, st.lastSync ? `last sync ${new Date(st.lastSync).toLocaleTimeString()}` : '', st.message].filter(Boolean).join(' · ')}
          value={col.syncJournal.size ? `${col.syncJournal.size} pending` : undefined}
        >
          {label[st.state]}
        </Row>
        <Row onClick={() => (st.state === 'auth' ? location.reload() : void syncClient.sync())}>
          <span style="color:var(--accent)">{st.state === 'auth' ? 'Sign in again' : 'Sync now'}</span>
        </Row>
        <Row onClick={() => void reloadServerContent()}>
          <span style="color:var(--accent)">Reload deck content from server</span>
        </Row>
      </div>
      <p class="group-footer">Reviews, scheduling, flags, deck options and settings sync to your account. Card content comes from the server database.</p>
    </>
  );
}

const GESTURES: { label: string; value: GestureAction }[] = [
  { label: 'Nothing', value: 'none' },
  { label: 'Show answer', value: 'showAnswer' },
  { label: 'Again', value: 'again' },
  { label: 'Hard', value: 'hard' },
  { label: 'Good', value: 'good' },
  { label: 'Easy', value: 'easy' },
  { label: 'Undo', value: 'undo' },
  { label: 'Bury card', value: 'bury' },
  { label: 'Suspend card', value: 'suspend' },
  { label: 'Mark note', value: 'mark' },
  { label: 'Flag', value: 'flag' },
  { label: 'Edit note', value: 'edit' },
  { label: 'Card info', value: 'info' },
  { label: 'Replay audio', value: 'replay' },
];

export function SettingsScreen() {
  useCol();
  const s = col.settings;
  const set = (patch: Partial<S>) => {
    col.saveSettings(patch);
    applyTheme();
  };
  const zone = (which: 'tapQuestion' | 'tapAnswer', side: 'left' | 'center' | 'right', label: string) => (
    <SelectRow label={label} value={s[which][side]} options={GESTURES} onChange={(v) => set({ [which]: { ...s[which], [side]: v } })} />
  );
  const swipe = (dir: 'left' | 'right' | 'up' | 'down', label: string) => (
    <SelectRow label={label} value={s.swipe[dir]} options={GESTURES} onChange={(v) => set({ swipe: { ...s.swipe, [dir]: v } })} />
  );

  return (
    <div class="screen">
      <NavBar title="Settings" />
      <div class="content">
        <SyncGroup />
        <div class="group-title">Appearance</div>
        <div class="group">
          <SelectRow
            label="Theme"
            value={s.theme}
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
            onChange={(theme) => set({ theme })}
          />
          <SelectRow
            label="Card font size"
            value={s.fontScale}
            options={[0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8].map((v) => ({ label: `${Math.round(v * 100)}%`, value: v }))}
            onChange={(fontScale) => set({ fontScale })}
          />
        </div>

        <div class="group-title">Review</div>
        <div class="group">
          <SelectRow
            label="Scheduler"
            sub={s.scheduler === 'fsrs' ? 'FSRS-6: intervals from a memory model and your desired retention' : 'SM-2: Anki’s legacy ease-factor algorithm'}
            value={s.scheduler}
            options={[
              { label: 'FSRS', value: 'fsrs' },
              { label: 'SM-2 (legacy)', value: 'sm2' },
            ]}
            onChange={(scheduler) => set({ scheduler })}
          />
          <SwitchRow label="Show next interval on buttons" checked={s.showIntervals} onChange={(showIntervals) => set({ showIntervals })} />
          <SwitchRow label="Show remaining card count" checked={s.showRemaining} onChange={(showRemaining) => set({ showRemaining })} />
          <SwitchRow
            label="Interval fuzz"
            sub="Randomize review intervals slightly so cards added together spread out"
            checked={s.fuzz}
            onChange={(fuzz) => set({ fuzz })}
          />
          <NumberRow label="Next day starts at (hour)" value={s.rolloverHour} min={0} max={23} onChange={(rolloverHour) => set({ rolloverHour })} />
          <NumberRow label="Learn ahead limit (minutes)" value={s.learnAheadMins} min={0} max={120} onChange={(learnAheadMins) => set({ learnAheadMins })} />
          <SwitchRow
            label="New cards ignore review limit"
            checked={s.newIgnoresReviewLimit}
            onChange={(newIgnoresReviewLimit) => set({ newIgnoresReviewLimit })}
          />
        </div>
        <p class="group-footer">Daily limits, learning steps and desired retention live in each deck's options preset.</p>

        <div class="group-title">Tap zones — question side</div>
        <div class="group">
          {zone('tapQuestion', 'left', 'Left')}
          {zone('tapQuestion', 'center', 'Center')}
          {zone('tapQuestion', 'right', 'Right')}
        </div>
        <div class="group-title">Tap zones — answer side</div>
        <div class="group">
          {zone('tapAnswer', 'left', 'Left')}
          {zone('tapAnswer', 'center', 'Center')}
          {zone('tapAnswer', 'right', 'Right')}
        </div>
        <div class="group-title">Swipe gestures</div>
        <div class="group">
          {swipe('left', 'Swipe left')}
          {swipe('right', 'Swipe right')}
          {swipe('up', 'Swipe up')}
          {swipe('down', 'Swipe down')}
        </div>
        <p class="group-footer">Swiping before the answer is shown reveals it. Vertical swipes only work when the card doesn't scroll.</p>

        <div class="group-title">Collection</div>
        <div class="group">
          <Row href="#/presets" chevron>Deck option presets</Row>
          <Row href="#/tags" chevron>Tags</Row>
          <Row href="#/notetypes" chevron>Note types</Row>
          <Row href="#/import" chevron>Import / export / backup</Row>
          <Row href="#/help/shortcuts" chevron>Keyboard shortcuts</Row>
        </div>

        <div class="group">
          <button
            class="row"
            style="color:var(--danger)"
            onClick={async () => {
              const synced = syncClient.status.state !== 'disabled';
              const msg = synced
                ? 'Local data in this browser will be erased. Synced data stays on the server and is downloaded again on next sync.'
                : 'All decks, cards, review history and media in this browser will be erased. Export a backup first if you want to keep them.';
              if (!(await confirm('Erase local data?', msg, 'Erase', true))) return;
              await col.wipe();
              applyTheme();
              toast('Collection erased');
              navigate('', true);
              if (synced) location.reload();
            }}
          >
            Erase local data
          </button>
        </div>
        <p class="center muted" style="font-size:13px">
          {col.cards.size} cards · {col.notes.size} notes · {col.revlog.size} reviews
          <br />
          Open source ·{' '}
          <a href="https://github.com/mlynchdev/anki-flashcards-web" target="_blank" rel="noopener">
            GitHub
          </a>
        </p>
      </div>
    </div>
  );
}

export function ShortcutsHelp() {
  const rows: [string, string][] = [
    ['Space / Enter', 'Show answer, then Good'],
    ['1 2 3 4', 'Again / Hard / Good / Easy'],
    ['u, z, Ctrl+Z', 'Undo'],
    ['e', 'Edit note'],
    ['i', 'Card info'],
    ['-', 'Bury card'],
    ['=', 'Bury note'],
    ['@', 'Suspend card'],
    ['!', 'Suspend note'],
    ['*', 'Mark note'],
    ['Ctrl+1 … Ctrl+7', 'Toggle flag colour (Ctrl+0 removes)'],
    ['r', 'Replay audio'],
    ['Esc', 'Leave study'],
    ['Ctrl+Enter', 'Add / save in the editor'],
    ['Ctrl+Shift+C', 'Cloze deletion in the editor'],
  ];
  return (
    <div class="screen">
      <NavBar title="Keyboard Shortcuts" backTo="settings" />
      <div class="content">
        <div class="group">
          {rows.map(([k, v]) => (
            <div class="row static">
              <div class="grow">{v}</div>
              <span class="kbd">{k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
