import { useEffect, useState } from 'preact/hooks';
import { col, toast } from './state';
import { AuthRequiredError, SyncClient, httpTransport, loadServerContent, serverIdentity, type SyncStatus } from '../sync/client';

export const syncClient = new SyncClient(col, httpTransport);

export function useSyncStatus(): SyncStatus {
  const [s, set] = useState(syncClient.status);
  useEffect(() => {
    const off = syncClient.onChange(() => set(syncClient.status));
    return () => void off();
  }, []);
  return s;
}

let started = false;

/** Connects to the Worker API when the app is served by it: pull state, load D1 content, keep syncing. */
export async function startServerSync() {
  if (started) return;
  let me: { email: string } | null;
  try {
    me = await serverIdentity();
  } catch (e) {
    if (e instanceof AuthRequiredError) syncClient.status = { state: 'auth', message: e.message };
    return;
  }
  if (!me) return; // static hosting or `vite dev`: local-only mode
  started = true;
  syncClient.status = { state: 'idle', email: me.email };

  await syncClient.sync();
  try {
    const n = await loadServerContent(col);
    if (n) toast(`Loaded ${n} notes from the server`);
  } catch (e) {
    console.warn('content load failed', e);
  }
  await syncClient.sync();

  let timer: ReturnType<typeof setTimeout> | undefined;
  col.subscribe(() => {
    if (!col.syncJournal.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => void syncClient.sync(), 4000);
  });
  setInterval(() => void syncClient.sync(), 60_000);
  window.addEventListener('online', () => void syncClient.sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncClient.sync();
  });
}

export async function reloadServerContent() {
  try {
    const n = await loadServerContent(col, true);
    toast(n ? `Updated ${n} notes from the server` : 'Content is up to date');
    await syncClient.sync();
  } catch (e) {
    toast((e as Error).message);
  }
}
