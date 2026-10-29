const DAY_MS = 86_400_000;

/**
 * Day number of a timestamp: whole days since 1970-01-01 in local time, where each day
 * starts at `rolloverHour` (Anki's "next day starts at"). DST safe.
 */
export function dayOf(ts: number, rolloverHour: number): number {
  const d = new Date(ts - rolloverHour * 3_600_000);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Timestamp at which the given day number starts. */
export function dayStart(day: number, rolloverHour: number): number {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), rolloverHour).getTime();
}

export function formatInterval(secs: number): string {
  const mins = secs / 60;
  if (mins < 1) return `${Math.max(1, Math.round(secs))}s`;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${trim(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${trim(days / 30.4375)}mo`;
  return `${trim(days / 365.25)}y`;
}

export function formatDays(days: number): string {
  return formatInterval(days * 86400);
}

function trim(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
