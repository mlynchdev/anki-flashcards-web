// Pushes local changes to the per-user Durable Object and pulls changes made on other devices.
// IndexedDB stays the source of truth while offline; conflicts resolve last-write-wins per record.
import type { Collection } from '../core/collection';
import { MAX_PUSH, type SyncRequest, type SyncResponse, type SyncRow } from './protocol';
import { importRows, type CardStoreRow } from '../importers/ankidb';

export type Transport = (req: SyncRequest) => Promise<SyncResponse>;

export class AuthRequiredError extends Error {}

export interface SyncStatus {
  state: 'disabled' | 'idle' | 'syncing' | 'offline' | 'auth' | 'error';
  message?: string;
  lastSync?: number;
  email?: string;
}

export class SyncClient {
  status: SyncStatus = { state: 'disabled' };
  private running: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<() => void>();

  constructor(
    private col: Collection,
    private transport: Transport,
  ) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s };
    for (const l of this.listeners) l();
  }

  /** Runs a sync; concurrent calls coalesce into one follow-up run. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.running;
  }

  private async run() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.set({ state: 'offline' });
      return;
    }
    this.set({ state: 'syncing', message: undefined });
    try {
      for (let i = 0; i < 200; i++) {
        const pending = this.col.pendingChanges(MAX_PUSH);
        const res = await this.transport({
          clientId: this.col.syncState.clientId,
          since: this.col.syncState.cursor,
          changes: pending.map(({ store, id, changedAt, data }) => ({ store, id, changedAt, data }) as SyncRow),
        });
        this.col.markPushed(pending);
        this.col.applyRemote(res.rows);
        this.col.saveSyncState({ cursor: res.cursor });
        if (!res.more && (pending.length < MAX_PUSH || this.col.syncJournal.size === 0)) break;
      }
      await this.col.flush();
      this.set({ state: 'idle', lastSync: Date.now() });
    } catch (e) {
      if (e instanceof AuthRequiredError) this.set({ state: 'auth', message: e.message });
      else if (e instanceof TypeError) this.set({ state: 'offline', message: e.message });
      else this.set({ state: 'error', message: (e as Error).message });
    }
  }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  // `manual` so an expired Access session (302 to the login page) is detected instead of followed.
  const res = await fetch(path, { credentials: 'same-origin', redirect: 'manual', ...init });
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    throw new AuthRequiredError('Sign in again through Cloudflare Access (reload the page)');
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

export const httpTransport: Transport = async (req) => {
  const res = await api('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  return res.json();
};

/** The signed-in identity, or null when the app isn't served by the Worker (static hosting, dev). */
export async function serverIdentity(): Promise<{ email: string } | null> {
  try {
    const res = await api('/api/me');
    if (!res.headers.get('content-type')?.includes('application/json')) return null;
    return await res.json();
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    return null;
  }
}

/** Loads deck content from D1 through the Worker; skipped when the version hasn't changed. */
export async function loadServerContent(col: Collection, force = false): Promise<number> {
  const res = await api('/api/content');
  const { version, rows } = (await res.json()) as { version: string; rows: CardStoreRow[] };
  if (!force && col.localMeta.contentVersion === version) return 0;
  const r = importRows(col, rows, { deterministic: true });
  col.saveLocalMeta({ contentVersion: version });
  await col.flush();
  return r.notesAdded + r.notesUpdated;
}
