import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import { back } from './state';

const paths: Record<string, string> = {
  decks: 'M4 6h16M4 12h16M4 18h10',
  add: 'M12 5v14M5 12h14',
  browse: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  stats: 'M5 20V10M12 20V4M19 20v-7',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'M9 6l6 6-6 6',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  info: 'M12 16v-4M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  flag: 'M4 22V4M4 4h12l-2 4 2 4H4',
  star: 'M12 3l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.4l6-.9z',
  import: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  check: 'M5 12l5 5L20 7',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  sort: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',
  play: 'M7 4l13 8-13 8z',
};

export function Icon({ name, size }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

export function NavBar(props: {
  title: ComponentChildren;
  backTo?: string;
  onBack?: () => void;
  left?: ComponentChildren;
  right?: ComponentChildren;
}) {
  return (
    <header class="navbar">
      <div class="left">
        {props.left ??
          ((props.backTo !== undefined || props.onBack) && (
            <button class="text-btn" onClick={() => (props.onBack ? props.onBack() : back(props.backTo))} aria-label="Back">
              ‹ Back
            </button>
          ))}
      </div>
      <h1>{props.title}</h1>
      <div class="right">{props.right}</div>
    </header>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label class="switch">
      <input
        type="checkbox"
        checked={props.checked}
        aria-label={props.label}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      <span />
    </label>
  );
}

export function Row(props: {
  children: ComponentChildren;
  sub?: ComponentChildren;
  value?: ComponentChildren;
  onClick?: () => void;
  href?: string;
  chevron?: boolean;
  class?: string;
}) {
  const inner = (
    <>
      <div class="grow">
        <div>{props.children}</div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      {props.value !== undefined && <div class="value">{props.value}</div>}
      {props.chevron && (
        <span class="chevron">
          <Icon name="chevron" size={16} />
        </span>
      )}
    </>
  );
  if (props.href) return <a class={`row ${props.class ?? ''}`} href={props.href}>{inner}</a>;
  if (props.onClick) return <button class={`row ${props.class ?? ''}`} onClick={props.onClick}>{inner}</button>;
  return <div class={`row static ${props.class ?? ''}`}>{inner}</div>;
}

export function Sheet(props: { onClose: () => void; title?: string; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose]);
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-label={props.title}>
        {props.title && <h2>{props.title}</h2>}
        {props.children}
      </div>
    </div>
  );
}

export interface SheetAction {
  label: string;
  run: () => void;
  destructive?: boolean;
  hidden?: boolean;
}

export function ActionSheet(props: { title?: string; actions: SheetAction[]; onClose: () => void }) {
  return (
    <Sheet onClose={props.onClose} title={props.title}>
      <div class="group">
        {props.actions
          .filter((a) => !a.hidden)
          .map((a) => (
            <button
              class={`row ${a.destructive ? 'destructive' : ''}`}
              onClick={() => {
                props.onClose();
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
      </div>
      <div class="group">
        <button class="row" style="font-weight:600" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ---------- imperative dialogs ----------

function mount<T>(build: (resolve: (v: T) => void) => JSX.Element): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const done = (v: T) => {
      render(null, host);
      host.remove();
      resolve(v);
    };
    render(build(done), host);
  });
}

export function actionSheet(title: string | undefined, actions: SheetAction[]): Promise<void> {
  return mount<void>((done) => <ActionSheet title={title} actions={actions} onClose={() => done()} />);
}

function PromptDialog(props: {
  title: string;
  message?: string;
  initial: string;
  placeholder?: string;
  ok: string;
  type?: 'text' | 'number';
  done: (v: string | null) => void;
}) {
  const [value, setValue] = useState(props.initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <Sheet onClose={() => props.done(null)} title={props.title}>
      <form
        class="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          props.done(value);
        }}
      >
        {props.message && <p class="muted" style="margin-top:0">{props.message}</p>}
        <input
          ref={ref}
          type="text"
          inputMode={props.type === 'number' ? 'numeric' : undefined}
          value={value}
          placeholder={props.placeholder}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={() => props.done(null)}>
            Cancel
          </button>
          <button type="submit" class="btn primary">
            {props.ok}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function prompt(
  title: string,
  initial = '',
  opts: { message?: string; placeholder?: string; ok?: string; type?: 'text' | 'number' } = {},
): Promise<string | null> {
  return mount<string | null>((done) => (
    <PromptDialog title={title} initial={initial} ok={opts.ok ?? 'OK'} {...opts} done={done} />
  ));
}

export function confirm(title: string, message?: string, ok = 'OK', destructive = false): Promise<boolean> {
  return mount<boolean>((done) => (
    <Sheet onClose={() => done(false)} title={title}>
      <div class="dialog-body">
        {message && <p class="muted center" style="margin-top:0;white-space:pre-line">{message}</p>}
        <div class="dialog-actions">
          <button class="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button class={`btn ${destructive ? 'danger' : 'primary'}`} onClick={() => done(true)} autoFocus>
            {ok}
          </button>
        </div>
      </div>
    </Sheet>
  ));
}

export function choose<T>(title: string, options: { label: string; value: T }[]): Promise<T | null> {
  return mount<T | null>((done) => (
    <Sheet onClose={() => done(null)} title={title}>
      <div class="group">
        {options.map((o) => (
          <button class="row left" onClick={() => done(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      <div class="group">
        <button class="row" onClick={() => done(null)}>
          Cancel
        </button>
      </div>
    </Sheet>
  ));
}

export function NumberRow(props: {
  label: string;
  sub?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div class="row static">
      <div class="grow">
        <div>{props.label}</div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      <input
        type="number"
        inputMode="decimal"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onChange={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) props.onChange(Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v)));
        }}
      />
    </div>
  );
}

export function SelectRow<T extends string | number>(props: {
  label: string;
  sub?: string;
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="row static">
      <div class="grow">
        <div>{props.label}</div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      <select
        style="width:auto;max-width:55%"
        value={String(props.value)}
        onChange={(e) => {
          const raw = (e.target as HTMLSelectElement).value;
          const opt = props.options.find((o) => String(o.value) === raw);
          if (opt) props.onChange(opt.value);
        }}
      >
        {props.options.map((o) => (
          <option value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

export function SwitchRow(props: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="row static">
      <div class="grow">
        <div>{props.label}</div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      <Switch checked={props.checked} onChange={props.onChange} label={props.label} />
    </div>
  );
}
