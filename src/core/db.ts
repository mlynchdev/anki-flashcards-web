import { openDB, type IDBPDatabase } from 'idb';

export const STORES = ['cards', 'notes', 'notetypes', 'decks', 'configs', 'revlog', 'media', 'meta'] as const;
export type StoreName = (typeof STORES)[number];

export interface Persistence {
  loadAll(): Promise<Record<StoreName, unknown[]>>;
  write(puts: Map<StoreName, Map<IDBValidKey, unknown>>, dels: Map<StoreName, Set<IDBValidKey>>): Promise<void>;
  clear(): Promise<void>;
}

export class IdbPersistence implements Persistence {
  private db: Promise<IDBPDatabase>;
  constructor(name = 'anki-web') {
    this.db = openDB(name, 1, {
      upgrade(db) {
        for (const s of STORES) {
          if (s === 'media') db.createObjectStore(s, { keyPath: 'name' });
          else if (s === 'meta') db.createObjectStore(s, { keyPath: 'key' });
          else db.createObjectStore(s, { keyPath: 'id' });
        }
      },
    });
  }

  async loadAll() {
    const db = await this.db;
    const out = {} as Record<StoreName, unknown[]>;
    // Media blobs are loaded lazily.
    for (const s of STORES) out[s] = s === 'media' ? [] : await db.getAll(s);
    return out;
  }

  async getMedia(name: string): Promise<Blob | undefined> {
    const db = await this.db;
    const rec = (await db.get('media', name)) as { name: string; data: Blob } | undefined;
    return rec?.data;
  }

  async mediaNames(): Promise<string[]> {
    const db = await this.db;
    return (await db.getAllKeys('media')) as string[];
  }

  async write(puts: Map<StoreName, Map<IDBValidKey, unknown>>, dels: Map<StoreName, Set<IDBValidKey>>) {
    const db = await this.db;
    const names = new Set<StoreName>([...puts.keys(), ...dels.keys()]);
    if (!names.size) return;
    const tx = db.transaction([...names], 'readwrite');
    for (const [store, map] of puts) for (const v of map.values()) void tx.objectStore(store).put(v);
    for (const [store, keys] of dels) for (const k of keys) void tx.objectStore(store).delete(k);
    await tx.done;
  }

  async clear() {
    const db = await this.db;
    const tx = db.transaction([...STORES], 'readwrite');
    for (const s of STORES) void tx.objectStore(s).clear();
    await tx.done;
  }
}

/** In-memory persistence for tests. */
export class MemoryPersistence implements Persistence {
  data = new Map<StoreName, Map<IDBValidKey, unknown>>();
  async loadAll() {
    const out = {} as Record<StoreName, unknown[]>;
    for (const s of STORES) out[s] = [...(this.data.get(s)?.values() ?? [])];
    return out;
  }
  async write(puts: Map<StoreName, Map<IDBValidKey, unknown>>, dels: Map<StoreName, Set<IDBValidKey>>) {
    for (const [s, m] of puts) {
      if (!this.data.has(s)) this.data.set(s, new Map());
      for (const [k, v] of m) this.data.get(s)!.set(k, structuredClone(v));
    }
    for (const [s, keys] of dels) for (const k of keys) this.data.get(s)?.delete(k);
  }
  async clear() {
    this.data.clear();
  }
}
