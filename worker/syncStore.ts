// Last-write-wins record store used inside the per-user Durable Object. Written against a tiny SQL
// interface so it can be unit-tested with sql.js.
import { MAX_PULL, MAX_PUSH, SYNC_STORES, type SyncRequest, type SyncResponse, type SyncRow, type SyncStore } from '../src/sync/protocol';

export interface Sql {
  exec(query: string, ...params: (string | number | null)[]): Record<string, unknown>[];
}

export class SyncStoreDb {
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL,
      id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      client TEXT NOT NULL,
      data TEXT,
      PRIMARY KEY (store, id)
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS records_seq ON records(seq)');
    sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  }

  private nextSeq(): number {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'seq'")[0];
    const seq = Number(row?.value ?? 0) + 1;
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seq);
    return seq;
  }

  sync(req: SyncRequest): SyncResponse {
    if (!req || typeof req.clientId !== 'string' || !Array.isArray(req.changes)) throw new Error('bad request');
    if (req.changes.length > MAX_PUSH) throw new Error(`too many changes (max ${MAX_PUSH})`);
    let accepted = 0;
    for (const c of req.changes) {
      if (!SYNC_STORES.includes(c.store as SyncStore) || typeof c.id !== 'string' || !Number.isFinite(c.changedAt)) continue;
      const existing = this.sql.exec('SELECT changed_at FROM records WHERE store = ? AND id = ?', c.store, c.id)[0];
      if (existing && Number(existing.changed_at) > c.changedAt) continue;
      const seq = this.nextSeq();
      this.sql.exec(
        `INSERT INTO records (store, id, changed_at, seq, client, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(store, id) DO UPDATE SET changed_at = excluded.changed_at, seq = excluded.seq,
           client = excluded.client, data = excluded.data`,
        c.store,
        c.id,
        c.changedAt,
        seq,
        req.clientId,
        c.data === null || c.data === undefined ? null : JSON.stringify(c.data),
      );
      accepted++;
    }

    const since = Number.isFinite(req.since) ? req.since : 0;
    const scanned = this.sql.exec(
      'SELECT store, id, changed_at, seq, client, data FROM records WHERE seq > ? ORDER BY seq LIMIT ?',
      since,
      MAX_PULL + 1,
    );
    const more = scanned.length > MAX_PULL;
    const page = scanned.slice(0, MAX_PULL);
    const rows: SyncRow[] = page
      .filter((r) => r.client !== req.clientId)
      .map((r) => ({
        store: r.store as SyncStore,
        id: String(r.id),
        changedAt: Number(r.changed_at),
        data: r.data === null ? null : JSON.parse(String(r.data)),
      }));
    const cursor = page.length ? Number(page[page.length - 1].seq) : since;
    return { cursor, rows, more, accepted };
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.sql.exec('SELECT store, COUNT(*) AS n FROM records WHERE data IS NOT NULL GROUP BY store')) {
      out[String(r.store)] = Number(r.n);
    }
    return out;
  }
}
