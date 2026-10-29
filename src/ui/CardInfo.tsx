import { col, useCol } from './state';
import { NavBar } from './components';
import { CardState, FLAG_NAMES, RevlogType } from '../core/types';
import { formatDays, formatInterval } from '../core/time';
import { stripHtml } from '../core/template';

const STATE_NAMES = ['New', 'Learning', 'Review', 'Relearning'];
const TYPE_NAMES: Record<number, string> = {
  [RevlogType.Learn]: 'Learn',
  [RevlogType.Review]: 'Review',
  [RevlogType.Relearn]: 'Relearn',
  [RevlogType.Filtered]: 'Filtered',
  [RevlogType.Manual]: 'Manual',
};
const EASE_NAMES = ['Manual', 'Again', 'Hard', 'Good', 'Easy'];

const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function CardInfo(props: { cardId: number; onClose?: () => void }) {
  useCol();
  const card = col.cards.get(props.cardId);
  if (!card) return <div class="empty-state">Card not found.</div>;
  const note = col.notes.get(card.noteId)!;
  const nt = col.notetypes.get(note.notetypeId);
  const revs = col.revlogFor(card.id);
  const rated = revs.filter((r) => r.ease > 0);
  const totalTime = rated.reduce((s, r) => s + r.time, 0);
  const r = col.retrievability(card);
  const dueDay = col.dueDay(card);
  const deck = col.decks.get(card.deckId);
  const home = card.odid ? col.decks.get(card.odid) : undefined;

  const rows: [string, string][] = [
    ['Sort field', stripHtml(note.fields[nt?.sortField ?? 0] ?? '').slice(0, 120)],
    ['Added', fmtDate(note.id)],
    ['First review', rated.length ? fmtDate(rated[0].id) : '—'],
    ['Latest review', rated.length ? fmtDate(rated[rated.length - 1].id) : '—'],
    [
      'Due',
      card.suspended
        ? 'Suspended'
        : card.state === CardState.New
          ? `New #${card.due}`
          : card.state === CardState.Review
            ? fmtDate(col.dayStart(card.due))
            : fmtDateTime(card.due),
    ],
    ['State', STATE_NAMES[card.state] + (card.buried ? ' (buried)' : '')],
    ['Interval', card.state === CardState.New ? '—' : formatDays(card.ivl)],
    ['Ease', card.ease ? `${Math.round(card.ease * 100)}%` : '—'],
  ];
  if (card.stability !== undefined) rows.push(['Stability', formatDays(card.stability)]);
  if (card.difficulty !== undefined) rows.push(['Difficulty', `${Math.round(((card.difficulty - 1) / 9) * 100)}%`]);
  if (r !== undefined) rows.push(['Retrievability', `${Math.round(r * 100)}%`]);
  if (dueDay !== undefined && card.state === CardState.Review) {
    const d = dueDay - col.today;
    rows.push(['Due in', d === 0 ? 'Today' : d < 0 ? `${-d} days overdue` : `${d} days`]);
  }
  rows.push(
    ['Reviews', String(card.reps)],
    ['Lapses', String(card.lapses)],
    ['Average time', rated.length ? `${(totalTime / rated.length / 1000).toFixed(1)}s` : '—'],
    ['Total time', formatInterval(totalTime / 1000)],
    ['Flag', FLAG_NAMES[card.flag]],
    ['Card type', nt?.kind === 'cloze' ? `Cloze ${card.ord + 1}` : nt?.templates[card.ord]?.name ?? ''],
    ['Note type', nt?.name ?? ''],
    ['Deck', home ? `${deck?.name} (from ${home.name})` : deck?.name ?? ''],
    ['Tags', note.tags.join(' ') || '—'],
    ['Card ID', String(card.id)],
    ['Note ID', String(note.id)],
  );

  return (
    <div class="screen" style="min-height:auto">
      <NavBar
        title="Card Info"
        left={
          props.onClose ? (
            <button class="text-btn" onClick={props.onClose}>
              Close
            </button>
          ) : undefined
        }
        backTo={props.onClose ? undefined : 'browse'}
      />
      <div class="content">
        <div class="group">
          {rows.map(([k, v]) => (
            <div class="row static">
              <div class="grow">{k}</div>
              <div class="value" style="max-width:62%;text-align:right;overflow-wrap:anywhere">
                {v}
              </div>
            </div>
          ))}
        </div>
        <div class="group-title">Review history</div>
        <div class="stat-card" style="overflow-x:auto">
          {revs.length ? (
            <table class="simple">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Rating</th>
                  <th>Interval</th>
                  <th>{col.settings.scheduler === 'fsrs' ? 'S / D' : 'Ease'}</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {[...revs].reverse().map((rv) => (
                  <tr>
                    <td>{fmtDateTime(rv.id)}</td>
                    <td>{TYPE_NAMES[rv.type]}</td>
                    <td style={{ color: ['var(--fg-muted)', 'var(--again)', 'var(--hard)', 'var(--good)', 'var(--easy)'][rv.ease] }}>
                      {EASE_NAMES[rv.ease]}
                    </td>
                    <td>{rv.ivl === 0 ? '—' : rv.ivl < 0 ? formatInterval(-rv.ivl) : formatDays(rv.ivl)}</td>
                    <td>
                      {col.settings.scheduler === 'fsrs' && rv.stability !== undefined
                        ? `${rv.stability.toFixed(1)}d / ${Math.round((((rv.difficulty ?? 1) - 1) / 9) * 100)}%`
                        : rv.factor
                          ? `${Math.round(rv.factor / 10)}%`
                          : '—'}
                    </td>
                    <td>{(rv.time / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="muted center">No reviews yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
