// Wire format shared by the client sync engine and the per-user Durable Object.

export const SYNC_STORES = ['cards', 'notes', 'notetypes', 'decks', 'configs', 'revlog', 'settings'] as const;
export type SyncStore = (typeof SYNC_STORES)[number];

/** One record version. `data: null` is a deletion (tombstone). */
export interface SyncRow {
  store: SyncStore;
  id: string;
  /** Client timestamp (ms) of the change; the newest change wins. */
  changedAt: number;
  data: unknown | null;
}

export interface SyncRequest {
  clientId: string;
  /** Server cursor from the previous sync (0 = everything). */
  since: number;
  changes: SyncRow[];
}

export interface SyncResponse {
  /** Pass back as `since` next time. */
  cursor: number;
  /** Rows changed on the server since `since`, written by other clients. */
  rows: SyncRow[];
  /** More rows are waiting; call again with the new cursor. */
  more: boolean;
  /** How many pushed changes were newer than the server copy and were applied. */
  accepted: number;
}

export const MAX_PUSH = 1000;
export const MAX_PULL = 2000;
