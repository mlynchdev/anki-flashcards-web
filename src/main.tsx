import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { App } from './ui/App';
import { applyTheme, col } from './ui/state';
import { startServerSync } from './ui/sync';

async function start() {
  const root = document.getElementById('app')!;
  try {
    await col.load();
  } catch (e) {
    root.innerHTML = `<div class="empty-state"><h2>Could not open storage</h2><p>${String(e)}</p></div>`;
    return;
  }
  applyTheme();
  render(<App />, root);
  // Flush pending writes when the page is hidden (e.g. app switched on iOS).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void col.flush();
  });
  window.addEventListener('pagehide', () => void col.flush());
  if (navigator.storage?.persist) void navigator.storage.persist();
  void startServerSync();
}

void start();
registerSW({ immediate: true });
