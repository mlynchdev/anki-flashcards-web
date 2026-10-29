import DOMPurify from 'dompurify';
import { useEffect, useRef } from 'preact/hooks';
import { col, isDark } from './state';

const BASE_CSS = `
:host { display: block; }
.card { min-height: 100%; padding: 22px 18px 40px; zoom: var(--card-scale, 1); overflow-wrap: anywhere; }
.card img { max-width: 100%; height: auto; }
.card hr#answer { border: 0; border-top: 1px solid #8884; margin: 18px 0; }
.card pre, .card code { white-space: pre-wrap; }
.card details.hint summary { color: #2563eb; cursor: pointer; }
.card .missing { color: #c00; font-size: .8em; }
.card table { border-collapse: collapse; margin: 0 auto; }
.card td, .card th { border: 1px solid #8886; padding: 4px 8px; }
`;

const OVERRIDES_LIGHT = `.card { background: transparent !important; }`;
const OVERRIDES_DARK = `.card { background: transparent !important; color: #ececf1 !important; }
.card a { color: #7fb0ff; }`;

const mediaUrls = new Map<string, string>();

async function mediaUrl(name: string): Promise<string | undefined> {
  const cached = mediaUrls.get(name);
  if (cached) return cached;
  if (!col.mediaNames.has(name)) return undefined;
  const blob = await col.getMedia(name);
  if (!blob) return undefined;
  const url = URL.createObjectURL(blob);
  mediaUrls.set(name, url);
  return url;
}

function soundTags(html: string): string {
  return html.replace(/\[sound:([^\]]+)\]/g, (_m, f: string) => `<audio controls preload="none" src="${f.replace(/"/g, '&quot;')}"></audio>`);
}

export function sanitize(html: string): string {
  return DOMPurify.sanitize(soundTags(html), {
    ADD_TAGS: ['audio', 'source', 'details', 'summary', 'ruby', 'rb', 'rt'],
    ADD_ATTR: ['controls', 'preload', 'data-cloze', 'target'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'style', 'link', 'meta'],
  });
}

/** Renders card HTML in a shadow root so note type CSS cannot leak into the app. */
export function CardView(props: { html: string; css: string; className?: string; autoplay?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const dark = isDark();
    root.innerHTML = `<style>${BASE_CSS}\n${props.css}\n${dark ? OVERRIDES_DARK : OVERRIDES_LIGHT}</style><div class="card ${
      dark ? 'nightMode night_mode' : ''
    } ${props.className ?? ''}">${sanitize(props.html)}</div>`;
    root.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    let cancelled = false;
    const media = root.querySelectorAll<HTMLImageElement | HTMLAudioElement | HTMLSourceElement>('img[src], audio[src], source[src]');
    let firstAudio: HTMLAudioElement | null = null;
    media.forEach((m) => {
      const src = m.getAttribute('src') ?? '';
      if (/^(https?:|data:|blob:)/i.test(src)) return;
      const name = decodeURIComponent(src);
      void mediaUrl(name).then((url) => {
        if (!cancelled && url) m.setAttribute('src', url);
      });
      if (m instanceof HTMLAudioElement && !firstAudio) firstAudio = m;
    });
    if (props.autoplay && firstAudio) {
      const a = firstAudio as HTMLAudioElement;
      setTimeout(() => !cancelled && a.play().catch(() => undefined), 50);
    }
    return () => {
      cancelled = true;
    };
  }, [props.html, props.css, props.className, props.autoplay]);
  return <div ref={host} class="card-host" />;
}

/** Plays the first audio element on the card again. */
export function replayAudio(container: HTMLElement | null) {
  const host = container?.querySelector('.card-host') as HTMLElement | null;
  const audio = host?.shadowRoot?.querySelector('audio');
  if (audio) {
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  }
}
