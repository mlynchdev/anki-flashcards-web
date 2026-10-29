import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';

let sqlPromise: Promise<SqlJsStatic> | null = null;

/** Loads sql.js once. In the browser the wasm is served as a bundled asset; in Node it is read from node_modules. */
export function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    if (typeof window === 'undefined') {
      sqlPromise = initSqlJs();
    } else {
      sqlPromise = import('sql.js/dist/sql-wasm.wasm?url').then((m) =>
        initSqlJs({ locateFile: () => (m as { default: string }).default }),
      );
    }
  }
  return sqlPromise;
}

export async function openDatabase(bytes: Uint8Array): Promise<Database> {
  const SQL = await getSql();
  return new SQL.Database(bytes);
}

/** Runs a query and returns rows as objects. */
export function rows<T = Record<string, unknown>>(db: Database, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params as never);
  const out: T[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as T);
  stmt.free();
  return out;
}

export function tableNames(db: Database): Set<string> {
  return new Set(rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((r) => r.name));
}

export interface ImportResult {
  format: string;
  notesAdded: number;
  notesUpdated: number;
  cards: number;
  decks: number;
  revlog: number;
  media: number;
}
