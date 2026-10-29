import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import './stats.css';
import { formatDays } from '../core/time';
import {
  REVIEW_KINDS,
  type Histogram,
  type Period,
  type ReviewKind,
  aheadDays,
  answerButtons,
  backDays,
  bucketTime,
  bucketTotal,
  cardCounts,
  difficultyHistogram,
  easeHistogram,
  forecast,
  formatDay,
  formatDuration,
  formatPercent,
  groupBuckets,
  heatmap,
  hourly,
  intervalHistogram,
  retentionRate,
  retrievabilityHistogram,
  reviewTotals,
  reviewsPerDay,
  scopeCards,
  scopeRevlog,
  stabilityHistogram,
  sumGroups,
  todayStats,
  trueRetention,
} from '../core/stats';
import { CardState } from '../core/types';
import { NavBar } from './components';
import { col, useCol } from './state';

const MAX_BARS = 120;

const PERIODS: { id: Period; label: string }[] = [
  { id: '1m', label: '1 month' },
  { id: '3m', label: '3 months' },
  { id: '1y', label: '1 year' },
  { id: 'all', label: 'All' },
];

const KIND_META: Record<ReviewKind, { label: string; color: string }> = {
  learn: { label: 'Learn', color: 'var(--learn)' },
  young: { label: 'Young', color: 'var(--c-young)' },
  mature: { label: 'Mature', color: 'var(--review)' },
  relearn: { label: 'Relearn', color: 'var(--again)' },
  filtered: { label: 'Filtered', color: 'var(--accent)' },
};

// ---------- formatting ----------

const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n * 10) / 10));
const fmtMinutes = (m: number) => (m < 60 ? `${Math.round(m * 10) / 10}m` : `${Math.round((m / 6)) / 10}h`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toString();

// ---------- charts ----------

interface Seg {
  v: number;
  color: string;
}

interface BarDatum {
  segs: Seg[];
  title: string;
}

interface LineSeries {
  /** NaN breaks the line. */
  values: number[];
  max: number;
  fmt: (n: number) => string;
}

/** Smallest "round" number at or above `x`, made even when `integer` so the midpoint tick is whole. */
function niceCeil(x: number, integer: boolean): number {
  if (x <= 0) return integer ? 2 : 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  let out = 10 * mag;
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) {
    if (m * mag >= x) {
      out = m * mag;
      break;
    }
  }
  if (integer && out % 2 !== 0) out += 1;
  return out;
}

function BarChart(props: {
  bars: BarDatum[];
  xLabel: (i: number) => string;
  xTicks?: number[];
  fmtY?: (n: number) => string;
  integer?: boolean;
  line?: LineSeries;
  height?: number;
  label: string;
}) {
  const { bars } = props;
  const W = 360;
  const H = props.height ?? 170;
  const L = 34;
  const R = props.line ? 34 : 6;
  const T = 10;
  const B = 20;
  const pw = W - L - R;
  const ph = H - T - B;
  const n = Math.max(1, bars.length);
  const integer = props.integer ?? true;
  const fmtY = props.fmtY ?? fmtNum;
  const totals = bars.map((b) => b.segs.reduce((s, x) => s + x.v, 0));
  const top = niceCeil(totals.reduce((m, x) => Math.max(m, x), 0), integer);
  const bw = pw / n;
  const gap = bw > 4 ? Math.min(2, bw * 0.2) : 0;
  const y = (v: number) => T + ph - (v / top) * ph;

  const ticks =
    props.xTicks ??
    Array.from(new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (bars.length - 1)) / 4)))).filter((i) => i < bars.length);

  let path = '';
  if (props.line) {
    let pen = false;
    props.line.values.forEach((v, i) => {
      if (Number.isNaN(v)) {
        pen = false;
        return;
      }
      const x = L + bw * i + bw / 2;
      const yy = T + ph - (v / props.line!.max) * ph;
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`;
      pen = true;
    });
  }

  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.label}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line class={f === 0 ? 'base' : 'grid'} x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} />
          <text x={L - 4} y={y(top * f) + 3} text-anchor="end">
            {fmtY(top * f)}
          </text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x = L + bw * i + gap / 2;
        let acc = 0;
        return (
          <g class="bar" key={i}>
            <title>{b.title}</title>
            <rect class="hit" x={L + bw * i} y={T} width={bw} height={ph} />
            {b.segs.map((s, k) => {
              if (s.v <= 0) return null;
              const y0 = y(acc + s.v);
              const h = y(acc) - y0;
              acc += s.v;
              return <rect key={k} x={x} y={y0} width={Math.max(0.5, bw - gap)} height={h} style={{ fill: s.color }} />;
            })}
          </g>
        );
      })}
      {props.line && path && <path class="series" d={path} />}
      {props.line &&
        [0, 1].map((f) => (
          <text key={f} class="line-label" x={W - R + 4} y={y(top * f) + 3}>
            {props.line!.fmt(props.line!.max * f)}
          </text>
        ))}
      {ticks.map((i, k) => (
        <text
          key={i}
          x={L + bw * i + bw / 2}
          y={H - 5}
          text-anchor={ticks.length > 1 && k === 0 ? 'start' : k === ticks.length - 1 && ticks.length > 1 ? 'end' : 'middle'}
        >
          {props.xLabel(i)}
        </text>
      ))}
    </svg>
  );
}

function Legend(props: { items: { label: string; color: string }[] }) {
  return (
    <div class="chart-legend">
      {props.items.map((i) => (
        <span key={i.label}>
          <i class="swatch" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function HistChart(props: {
  h: Histogram;
  unit: string;
  color?: string;
  xLabel: (lo: number) => string;
  range: (lo: number, hi: number) => string;
  label: string;
}) {
  const { h } = props;
  if (!h.count) return <p class="muted">No data.</p>;
  const color = props.color ?? 'var(--c-neutral)';
  return (
    <BarChart
      label={props.label}
      bars={h.bins.map((b) => ({
        segs: [{ v: b.count, color }],
        title: `${props.range(b.lo, b.hi)}: ${plural(b.count, props.unit)}`,
      }))}
      xLabel={(i) => props.xLabel(h.bins[i].lo)}
    />
  );
}

const dayRange = (step: number) => (lo: number, hi: number) => (step === 1 ? `${lo}d` : `${lo}-${hi - 1}d`);
const dayLabel = (lo: number) => (lo === 0 ? '0' : formatDays(lo));
const pctRange = (lo: number, hi: number) => `${lo}-${hi}%`;
const pctLabel = (lo: number) => `${lo}%`;

// ---------- calendar heatmap ----------

const CELL = 11;
const PITCH = 13;
const HEAT_LEFT = 24;
const HEAT_TOP = 14;
const HEAT_FILL = [
  'var(--bg-sunk)',
  'color-mix(in srgb, var(--accent) 25%, transparent)',
  'color-mix(in srgb, var(--accent) 45%, transparent)',
  'color-mix(in srgb, var(--accent) 70%, transparent)',
  'var(--accent)',
];

function HeatmapChart(props: { map: ReturnType<typeof heatmap> }) {
  const { map } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [map]);

  const months: { col: number; label: string }[] = [];
  let prevMonth = -1;
  let lastCol = -10;
  for (const c of map.cells) {
    if (c.row !== 0 && c.col !== 0) continue;
    if (c.col === lastCol) continue;
    const month = new Date(c.day * 86_400_000).getUTCMonth();
    if (month !== prevMonth && c.col - lastCol >= 3) {
      months.push({ col: c.col, label: new Date(c.day * 86_400_000).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) });
      lastCol = c.col;
    }
    prevMonth = month;
  }

  const width = HEAT_LEFT + map.weeks * PITCH;
  const height = HEAT_TOP + 7 * PITCH;
  return (
    <div class="heat-scroll" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Review calendar">
        {months.map((m) => (
          <text key={m.col} x={HEAT_LEFT + m.col * PITCH} y={9}>
            {m.label}
          </text>
        ))}
        {[1, 3, 5].map((row) => (
          <text key={row} x={0} y={HEAT_TOP + row * PITCH + 9}>
            {['', 'Mon', '', 'Wed', '', 'Fri', ''][row]}
          </text>
        ))}
        {map.cells.map((c) => (
          <rect
            key={c.day}
            x={HEAT_LEFT + c.col * PITCH}
            y={HEAT_TOP + c.row * PITCH}
            width={CELL}
            height={CELL}
            rx={2}
            style={{ fill: HEAT_FILL[c.level] }}
          >
            <title>{`${formatDay(c.day)}: ${plural(c.count, 'review')}`}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

// ---------- small pieces ----------

function Card(props: { title: string; desc?: string; children: ComponentChildren }) {
  return (
    <section class="stat-card">
      <h3>{props.title}</h3>
      {props.desc && <p class="desc">{props.desc}</p>}
      {props.children}
    </section>
  );
}

function Tile(props: { k: string; v: ComponentChildren }) {
  return (
    <div>
      <div class="k">{props.k}</div>
      <div class="v">{props.v}</div>
    </div>
  );
}

function Seg2<T extends string>(props: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.id} class={o.id === props.value ? 'on' : ''} aria-pressed={o.id === props.value} onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- screen ----------

export function Stats() {
  useCol();
  const [scope, setScope] = useState('all');
  const [period, setPeriod] = useState<Period>('3m');
  const [mode, setMode] = useState<'count' | 'time'>('count');
  const today = col.today;
  const roll = col.settings.rolloverHour;
  const version = col.version;

  const decks = col.sortedDecks();
  const scopeId = scope === 'all' || !col.decks.has(Number(scope)) ? 'all' : scope;

  // Everything that depends only on the deck scope.
  const scoped = useMemo(() => {
    const ids = scopeId === 'all' ? null : new Set(col.deckAndChildren(Number(scopeId)).map((d) => d.id));
    const cards = scopeCards(col.cards.values(), ids);
    const cardIds = ids ? new Set(cards.map((c) => c.id)) : null;
    const log = scopeRevlog(col.revlog.values(), cardIds);
    const retr: number[] = [];
    for (const c of cards) {
      if (c.state === CardState.New) continue;
      const r = col.retrievability(c);
      if (r !== undefined && Number.isFinite(r)) retr.push(r);
    }
    return {
      cards,
      log,
      retr,
      counts: cardCounts(cards),
      intervals: intervalHistogram(cards),
      ease: easeHistogram(cards),
      difficulty: difficultyHistogram(cards),
      stability: stabilityHistogram(cards),
      retrievability: retrievabilityHistogram(retr),
      today: todayStats(log, today, roll),
      retention: trueRetention(log, today, roll),
      heat: heatmap(log, today, roll, 365),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, scopeId, today, roll]);

  // Everything that also depends on the period.
  const timed = useMemo(() => {
    const back = backDays(period, scoped.log, today, roll);
    const ahead = aheadDays(period);
    const fc = forecast(scoped.cards, today, ahead);
    const days = reviewsPerDay(scoped.log, today, roll, back);
    return {
      back,
      ahead,
      fc,
      days,
      totals: reviewTotals(days),
      hours: hourly(scoped.log, today, roll, back),
      buttons: answerButtons(scoped.log, today, roll, back),
    };
  }, [scoped, period, today, roll]);

  const { counts } = scoped;
  const t = scoped.today;

  return (
    <div class="screen">
      <NavBar title="Statistics" />
      <div class="content">
        <div class="stats-controls">
          <select value={scopeId} aria-label="Deck" onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
            <option value="all">Whole collection</option>
            {decks.map((d) => {
              const parts = d.name.split('::');
              return (
                <option key={d.id} value={String(d.id)}>
                  {'  '.repeat(parts.length - 1) + parts[parts.length - 1]}
                </option>
              );
            })}
          </select>
          <Seg2 value={period} options={PERIODS} onChange={setPeriod} label="Period" />
        </div>

        {/* 1. Today */}
        <Card title="Today">
          {t.answers === 0 ? (
            <p class="muted" style="margin:0">No cards studied today.</p>
          ) : (
            <>
              <div class="stat-grid">
                <Tile k="Cards studied" v={t.cards} />
                <Tile k="Time spent" v={formatDuration(t.timeMs)} />
                <Tile k="Average per card" v={`${oneDecimal(t.secsPerCard)}s`} />
                <Tile k="Again" v={`${t.again} (${formatPercent(t.again / t.answers)})`} />
                <Tile k="Correct" v={formatPercent(t.correct)} />
                <Tile k="Mature correct" v={t.matureAnswers ? `${formatPercent(t.matureCorrect)} (${t.matureAnswers})` : '-'} />
              </div>
              <p class="line muted">
                Learn {t.learn} · Review {t.review} · Relearn {t.relearn} · Filtered {t.filtered}
              </p>
            </>
          )}
        </Card>

        {/* 2. Forecast */}
        <ForecastCard fc={timed.fc} ahead={timed.ahead} />

        {/* 3. Reviews */}
        <Card title="Reviews" desc={`Answers per day over the last ${timed.back} days.`}>
          <Seg2
            value={mode}
            options={[
              { id: 'count', label: 'Count' },
              { id: 'time', label: 'Time' },
            ]}
            onChange={setMode}
            label="Reviews metric"
          />
          <ReviewsChart days={timed.days} mode={mode} />
          <Legend items={REVIEW_KINDS.map((k) => KIND_META[k])} />
          <div class="stat-grid sub-grid">
            <Tile k="Days studied" v={`${timed.totals.daysStudied} of ${timed.totals.days}`} />
            {mode === 'count' ? (
              <>
                <Tile k="Total" v={timed.totals.total} />
                <Tile k="Average (studied days)" v={Math.round(timed.totals.avgPerStudiedDay)} />
              </>
            ) : (
              <>
                <Tile k="Total time" v={formatDuration(timed.totals.timeMs)} />
                <Tile k="Average (studied days)" v={formatDuration(timed.totals.avgTimePerStudiedDayMs)} />
              </>
            )}
          </div>
        </Card>

        {/* 4. Card counts */}
        <CardCountsCard counts={counts} />

        {/* 5. Intervals */}
        <Card title="Review intervals" desc="Current interval of review cards.">
          <HistChart
            h={scoped.intervals}
            unit="card"
            label="Review interval histogram"
            xLabel={dayLabel}
            range={dayRange(scoped.intervals.step)}
          />
          {scoped.intervals.count > 0 && (
            <p class="line">
              Average: {formatDays(scoped.intervals.avg)} · Longest: {formatDays(scoped.intervals.max)}
            </p>
          )}
        </Card>

        {/* 6. Ease, difficulty, stability, retrievability */}
        <Card title="Card ease" desc="SM-2 ease factor of cards that have graduated.">
          <HistChart h={scoped.ease} unit="card" label="Ease histogram" xLabel={pctLabel} range={pctRange} />
          {scoped.ease.count > 0 && <p class="line">Average ease: {Math.round(scoped.ease.avg)}%</p>}
        </Card>
        <Card title="Difficulty" desc="FSRS difficulty, shown as (d-1)/9.">
          <HistChart h={scoped.difficulty} unit="card" label="Difficulty histogram" xLabel={pctLabel} range={pctRange} />
          {scoped.difficulty.count > 0 && <p class="line">Average difficulty: {Math.round(scoped.difficulty.avg)}%</p>}
        </Card>
        <Card title="Stability" desc="FSRS memory stability: the interval at which recall probability is 90%.">
          <HistChart
            h={scoped.stability}
            unit="card"
            label="Stability histogram"
            xLabel={dayLabel}
            range={dayRange(scoped.stability.step)}
          />
          {scoped.stability.count > 0 && (
            <p class="line">
              Average: {formatDays(scoped.stability.avg)} · Longest: {formatDays(scoped.stability.max)}
            </p>
          )}
        </Card>
        <Card title="Retrievability" desc="Current probability of recalling each card, per FSRS.">
          <HistChart
            h={scoped.retrievability}
            unit="card"
            label="Retrievability histogram"
            xLabel={pctLabel}
            range={pctRange}
          />
          {scoped.retrievability.count > 0 && <p class="line">Average retrievability: {Math.round(scoped.retrievability.avg)}%</p>}
        </Card>

        {/* 7. Calendar */}
        <Card title="Calendar" desc="Reviews per day over the past year.">
          <HeatmapChart map={scoped.heat} />
          <Legend
            items={[
              { label: 'None', color: HEAT_FILL[0] },
              { label: 'Few', color: HEAT_FILL[1] },
              { label: '', color: HEAT_FILL[2] },
              { label: '', color: HEAT_FILL[3] },
              { label: 'Many', color: HEAT_FILL[4] },
            ]}
          />
          <div class="stat-grid sub-grid">
            <Tile k="Days studied" v={`${scoped.heat.daysStudied} of 365`} />
            <Tile k="Current streak" v={plural(scoped.heat.currentStreak, 'day')} />
            <Tile k="Longest streak" v={plural(scoped.heat.longestStreak, 'day')} />
          </div>
        </Card>

        {/* 8. Hourly */}
        <Card title="Hourly breakdown" desc={`Answers by hour of day over the last ${timed.back} days. The line shows the success rate.`}>
          <HourlyChart hours={timed.hours} />
        </Card>

        {/* 9. Answer buttons */}
        <Card title="Answer buttons" desc={`How often each button was pressed over the last ${timed.back} days.`}>
          <ButtonsTable buttons={timed.buttons} />
        </Card>

        {/* 10. True retention */}
        <Card title="True retention" desc="Review answers only. Pass means Hard, Good or Easy. Mature means a previous interval of 21 days or more.">
          <RetentionTable rows={scoped.retention} />
        </Card>
      </div>
    </div>
  );
}

// ---------- sections ----------

function ForecastCard(props: { fc: ReturnType<typeof forecast>; ahead: number }) {
  const { fc, ahead } = props;
  const size = Math.ceil(ahead / MAX_BARS);
  const rest = sumGroups(fc.counts.slice(1), size);
  const values = [fc.counts[0], ...rest];
  let acc = 0;
  const cumulative = values.map((v) => (acc += v));
  const startOf = (i: number) => (i === 0 ? 0 : (i - 1) * size + 1);
  const endOf = (i: number) => (i === 0 ? 0 : Math.min(ahead, i * size));
  const rangeText = (i: number) =>
    i === 0 ? 'Today (including overdue)' : startOf(i) === endOf(i) ? `In ${plural(startOf(i), 'day')}` : `In ${startOf(i)}-${endOf(i)} days`;
  return (
    <Card title="Future due" desc={`Review cards due over the next ${ahead} days. Overdue cards count as today.`}>
      {fc.total === 0 ? (
        <p class="muted" style="margin:0">Nothing due in this period.</p>
      ) : (
        <>
          <BarChart
            label="Forecast of due reviews"
            bars={values.map((v, i) => ({
              segs: [{ v, color: 'var(--review)' }],
              title: `${rangeText(i)}: ${plural(v, 'card')} (${cumulative[i]} cumulative)`,
            }))}
            xLabel={(i) => (i === 0 ? 'Today' : `+${endOf(i)}d`)}
            line={{ values: cumulative, max: Math.max(1, cumulative[cumulative.length - 1]), fmt: fmtNum }}
          />
          <Legend
            items={[
              { label: 'Due', color: 'var(--review)' },
              { label: 'Cumulative', color: 'var(--accent)' },
            ]}
          />
        </>
      )}
      <div class="stat-grid sub-grid">
        <Tile k="Due tomorrow" v={fc.dueTomorrow} />
        <Tile k="Overdue" v={fc.overdue} />
        <Tile k="Total shown" v={fc.total} />
        <Tile k="Daily load" v={`≈ ${oneDecimal(fc.dailyLoad)}/day`} />
      </div>
    </Card>
  );
}

function ReviewsChart(props: { days: ReturnType<typeof reviewsPerDay>; mode: 'count' | 'time' }) {
  const { mode } = props;
  const size = Math.ceil(props.days.length / MAX_BARS);
  const buckets = groupBuckets(props.days, size);
  const total = props.days.reduce((n, b) => n + bucketTotal(b), 0);
  if (total === 0) return <p class="muted">No reviews in this period.</p>;
  const when = (b: (typeof buckets)[number]) =>
    b.span === 1 ? formatDay(b.day) : `${formatDay(b.day)} - ${formatDay(b.day + b.span - 1)}`;
  return (
    <BarChart
      label="Reviews per day"
      integer={mode === 'count'}
      fmtY={mode === 'count' ? fmtNum : fmtMinutes}
      bars={buckets.map((b) => ({
        segs: REVIEW_KINDS.map((k) => ({
          v: mode === 'count' ? b.counts[k] : b.times[k] / 60000,
          color: KIND_META[k].color,
        })),
        title:
          mode === 'count'
            ? `${when(b)}: ${plural(bucketTotal(b), 'review')}` +
              REVIEW_KINDS.filter((k) => b.counts[k]).map((k) => `\n${KIND_META[k].label}: ${b.counts[k]}`).join('')
            : `${when(b)}: ${formatDuration(bucketTime(b))}` +
              REVIEW_KINDS.filter((k) => b.times[k]).map((k) => `\n${KIND_META[k].label}: ${formatDuration(b.times[k])}`).join(''),
      }))}
      xLabel={(i) => formatDay(buckets[i].day)}
    />
  );
}

function CardCountsCard(props: { counts: ReturnType<typeof cardCounts> }) {
  const { counts } = props;
  const rows = [
    { key: 'new', label: 'New', color: 'var(--new)' },
    { key: 'learning', label: 'Learning', color: 'var(--learn)' },
    { key: 'relearning', label: 'Relearning', color: 'var(--c-relearn)' },
    { key: 'young', label: 'Young', color: 'var(--c-young)' },
    { key: 'mature', label: 'Mature', color: 'var(--review)' },
    { key: 'suspended', label: 'Suspended', color: 'var(--c-suspended)' },
    { key: 'buried', label: 'Buried', color: 'var(--c-buried)' },
  ] as const;
  return (
    <Card title="Card counts">
      {counts.total === 0 ? (
        <p class="muted" style="margin:0">No cards.</p>
      ) : (
        <>
          <div class="cc-bar" role="img" aria-label="Card counts">
            {rows.map(
              (r) =>
                counts[r.key] > 0 && (
                  <div
                    key={r.key}
                    style={{ flexGrow: counts[r.key], background: r.color }}
                    title={`${r.label}: ${counts[r.key]} (${formatPercent(counts[r.key] / counts.total, 1)})`}
                  />
                ),
            )}
          </div>
          <table class="simple">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <i class="swatch" style={{ background: r.color, marginRight: '8px' }} />
                    {r.label}
                  </td>
                  <td>{counts[r.key]}</td>
                  <td class="muted">{formatPercent(counts[r.key] / counts.total, 1)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td>
                  <strong>{counts.total}</strong>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function HourlyChart(props: { hours: ReturnType<typeof hourly> }) {
  const { hours } = props;
  if (hours.every((h) => h.count === 0)) return <p class="muted">No reviews in this period.</p>;
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <>
      <BarChart
        label="Reviews by hour"
        bars={hours.map((h) => ({
          segs: [{ v: h.count, color: 'var(--c-neutral)' }],
          title: `${hh(h.hour)}: ${plural(h.count, 'review')}${h.count ? `, ${formatPercent(h.correct / h.count)} correct` : ''}`,
        }))}
        xTicks={[0, 6, 12, 18, 23]}
        xLabel={(i) => String(i)}
        line={{
          values: hours.map((h) => (h.count ? (h.correct / h.count) * 100 : NaN)),
          max: 100,
          fmt: (n) => `${Math.round(n)}%`,
        }}
      />
      <Legend
        items={[
          { label: 'Reviews', color: 'var(--c-neutral)' },
          { label: 'Success rate', color: 'var(--accent)' },
        ]}
      />
    </>
  );
}

function ButtonsTable(props: { buttons: ReturnType<typeof answerButtons> }) {
  const groups = [
    { key: 'learning', label: 'Learning' },
    { key: 'young', label: 'Young' },
    { key: 'mature', label: 'Mature' },
  ] as const;
  const heads = [
    { label: 'Again', color: 'var(--again)' },
    { label: 'Hard', color: 'var(--hard)' },
    { label: 'Good', color: 'var(--good)' },
    { label: 'Easy', color: 'var(--easy)' },
  ];
  return (
    <div class="table-scroll">
      <table class="simple compact">
        <thead>
          <tr>
            <th />
            {heads.map((h) => (
              <th key={h.label} style={{ color: h.color }}>
                {h.label}
              </th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const c = props.buttons.counts[g.key];
            const total = c[0] + c[1] + c[2] + c[3];
            return (
              <tr key={g.key}>
                <td>{g.label}</td>
                {c.map((n, i) => (
                  <td key={i}>
                    {n}
                    <div class="small">{total ? formatPercent(n / total, 1) : '-'}</div>
                  </td>
                ))}
                <td>{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RetentionTable(props: { rows: ReturnType<typeof trueRetention> }) {
  return (
    <div class="table-scroll">
      <table class="simple compact">
        <thead>
          <tr>
            <th />
            <th class="group" colSpan={3}>
              Young
            </th>
            <th class="group" colSpan={3}>
              Mature
            </th>
            <th class="group" colSpan={3}>
              Total
            </th>
          </tr>
          <tr>
            <th />
            {[0, 1, 2].flatMap((g) => [
              <th key={`p${g}`}>Pass</th>,
              <th key={`f${g}`}>Fail</th>,
              <th key={`r${g}`}>%</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => {
            const tp = r.youngPass + r.maturePass;
            const tf = r.youngFail + r.matureFail;
            return (
              <tr key={r.label}>
                <td style="white-space:nowrap">{r.label}</td>
                <td>{r.youngPass}</td>
                <td>{r.youngFail}</td>
                <td>{formatPercent(retentionRate(r.youngPass, r.youngFail), 1)}</td>
                <td>{r.maturePass}</td>
                <td>{r.matureFail}</td>
                <td>{formatPercent(retentionRate(r.maturePass, r.matureFail), 1)}</td>
                <td>{tp}</td>
                <td>{tf}</td>
                <td>{formatPercent(retentionRate(tp, tf), 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
