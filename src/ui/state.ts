import { useEffect, useState, useReducer } from 'preact/hooks';
import { Collection } from '../core/collection';
import { IdbPersistence } from '../core/db';

export const persistence = new IdbPersistence();
export const col = new Collection(persistence);

/** Re-renders the component whenever the collection changes. */
export function useCol(): Collection {
  const [, force] = useReducer((x: number, _: void) => x + 1, 0);
  useEffect(() => col.subscribe(() => force()), []);
  return col;
}

// ---------- routing (hash based) ----------

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

let depth = 0;

export function navigate(path: string, replace = false) {
  const url = '#/' + path.replace(/^#?\/?/, '');
  if (replace) {
    history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    depth++;
    location.hash = url;
  }
}

/** Goes back within the app, or to `fallback` when there is no in-app history. */
export function back(fallback = '') {
  if (depth > 0) {
    depth--;
    history.back();
  } else navigate(fallback, true);
}

// ---------- toasts ----------

type ToastListener = (msg: string | null, action?: { label: string; run: () => void }) => void;
const toastListeners = new Set<ToastListener>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, action?: { label: string; run: () => void }) {
  for (const l of toastListeners) l(msg, action);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastListeners.forEach((l) => l(null)), action ? 4000 : 2200);
}

export function useToast() {
  const [state, setState] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
  useEffect(() => {
    const l: ToastListener = (msg, action) => setState(msg ? { msg, action } : null);
    toastListeners.add(l);
    return () => void toastListeners.delete(l);
  }, []);
  return [state, () => setState(null)] as const;
}

// ---------- theme ----------

export function applyTheme() {
  const s = col.settings;
  const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--card-scale', String(s.fontScale));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111318' : '#f6f7f9');
}

export function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

export function downloadFile(name: string, data: BlobPart, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
