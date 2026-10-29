import type { Notetype } from './types';

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(text: string): number[] {
  const set = new Set<number>();
  for (const m of text.matchAll(CLOZE_RE)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

/** Renders cloze deletions for card number `n`. */
export function renderCloze(text: string, n: number, question: boolean): string {
  return text.replace(CLOZE_RE, (_all, num: string, content: string, hint?: string) => {
    if (Number(num) !== n) return content;
    if (question) {
      return `<span class="cloze" data-cloze="${escapeAttr(content)}">[${hint ? escapeHtml(hint) : '...'}]</span>`;
    }
    return `<span class="cloze">${content}</span>`;
  });
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Plain text (as in this project's anki.db) to field HTML. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

export interface RenderContext {
  fields: Record<string, string>;
  tags: string[];
  deck: string;
  cardName: string;
  /** Cloze number (1-based) for cloze notetypes. */
  clozeOrd?: number;
  frontSide?: string;
}

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; name: string; filters: string[] }
  | { t: 'section'; name: string; inverted: boolean; children: Node[] };

function parse(tpl: string): Node[] {
  const root: Node[] = [];
  const stack: { name: string; children: Node[] }[] = [{ name: '', children: root }];
  const re = /\{\{([\s\S]+?)\}\}/g;
  let last = 0;
  for (const m of tpl.matchAll(re)) {
    const top = stack[stack.length - 1].children;
    if (m.index! > last) top.push({ t: 'text', v: tpl.slice(last, m.index) });
    last = m.index! + m[0].length;
    const tag = m[1].trim();
    if (tag.startsWith('#') || tag.startsWith('^')) {
      const node: Node = { t: 'section', name: tag.slice(1).trim(), inverted: tag[0] === '^', children: [] };
      top.push(node);
      stack.push({ name: node.name, children: node.children });
    } else if (tag.startsWith('/')) {
      if (stack.length > 1) stack.pop();
    } else if (tag.startsWith('!')) {
      // comment
    } else {
      const parts = tag.split(':');
      const name = parts.pop()!.trim();
      top.push({ t: 'var', name, filters: parts.map((p) => p.trim().toLowerCase()) });
    }
  }
  if (last < tpl.length) stack[stack.length - 1].children.push({ t: 'text', v: tpl.slice(last) });
  return root;
}

function fieldValue(name: string, ctx: RenderContext): string | undefined {
  switch (name) {
    case 'FrontSide':
      return ctx.frontSide ?? '';
    case 'Tags':
      return ctx.tags.join(' ');
    case 'Deck':
      return ctx.deck;
    case 'Subdeck':
      return ctx.deck.split('::').pop() ?? '';
    case 'Card':
      return ctx.cardName;
    case 'CardFlag':
      return '';
  }
  if (name in ctx.fields) return ctx.fields[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(ctx.fields)) if (k.toLowerCase() === lower) return ctx.fields[k];
  return undefined;
}

function nonEmpty(name: string, ctx: RenderContext): boolean {
  if (/^c\d+$/.test(name) && ctx.clozeOrd !== undefined) return Number(name.slice(1)) === ctx.clozeOrd;
  const v = fieldValue(name, ctx);
  return !!v && stripHtml(v).trim().length > 0;
}

function renderNodes(nodes: Node[], ctx: RenderContext, question: boolean): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'section') {
      if (nonEmpty(n.name, ctx) !== n.inverted) out += renderNodes(n.children, ctx, question);
    } else {
      let v = fieldValue(n.name, ctx);
      if (v === undefined) {
        out += n.filters.length ? '' : `<span class="missing">{{${escapeHtml(n.name)}}}</span>`;
        continue;
      }
      for (const f of [...n.filters].reverse()) {
        if (f === 'cloze') v = renderCloze(v, ctx.clozeOrd ?? 1, question);
        else if (f === 'text') v = escapeHtml(stripHtml(v));
        else if (f === 'type' || f === 'cloze-only' || f.startsWith('tts')) v = '';
        else if (f === 'hint') {
          v = v
            ? `<details class="hint"><summary>Show ${escapeHtml(n.name)}</summary>${v}</details>`
            : '';
        } else if (f === 'furigana' || f === 'kanji' || f === 'kana') {
          v = furigana(v, f);
        }
      }
      out += v;
    }
  }
  return out;
}

function furigana(v: string, mode: string): string {
  return v.replace(/ ?([^ >]+?)\[(.+?)\]/g, (_m, base: string, reading: string) =>
    mode === 'kanji' ? base : mode === 'kana' ? reading : `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`,
  );
}

const cache = new Map<string, Node[]>();
function compiled(tpl: string): Node[] {
  let n = cache.get(tpl);
  if (!n) {
    n = parse(tpl);
    if (cache.size > 200) cache.clear();
    cache.set(tpl, n);
  }
  return n;
}

export function renderTemplate(tpl: string, ctx: RenderContext, question: boolean): string {
  return renderNodes(compiled(tpl), ctx, question);
}

export function fieldMap(nt: Notetype, values: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  nt.fields.forEach((f, i) => (fields[f] = values[i] ?? ''));
  return fields;
}

export interface RenderedCard {
  question: string;
  answer: string;
}

export function renderCard(
  nt: Notetype,
  values: string[],
  ord: number,
  extras: { tags: string[]; deck: string },
): RenderedCard {
  const tpl = nt.kind === 'cloze' ? nt.templates[0] : nt.templates[ord] ?? nt.templates[0];
  const ctx: RenderContext = {
    fields: fieldMap(nt, values),
    tags: extras.tags,
    deck: extras.deck,
    cardName: nt.kind === 'cloze' ? `Cloze ${ord + 1}` : tpl.name,
    clozeOrd: nt.kind === 'cloze' ? ord + 1 : undefined,
  };
  const question = renderTemplate(tpl.qfmt, ctx, true);
  const answer = renderTemplate(tpl.afmt, { ...ctx, frontSide: question }, false);
  return { question, answer };
}

/** Which card ordinals a note should have. */
export function cardOrdinals(nt: Notetype, values: string[]): number[] {
  if (nt.kind === 'cloze') {
    const fields = fieldMap(nt, values);
    const clozeFields = [...nt.templates[0].qfmt.matchAll(/\{\{[^}]*cloze:([^}]+)\}\}/g)].map((m) => m[1].trim());
    const nums = new Set<number>();
    for (const f of clozeFields.length ? clozeFields : nt.fields) {
      for (const n of clozeNumbers(fields[f] ?? '')) nums.add(n);
    }
    return [...nums].sort((a, b) => a - b).map((n) => n - 1);
  }
  const ords: number[] = [];
  const empty = nt.fields.map(() => '');
  nt.templates.forEach((_t, i) => {
    const ctx = { tags: [], deck: '' };
    const filled = stripHtml(renderCard(nt, values, i, ctx).question).replace(/\s+/g, '');
    const blank = stripHtml(renderCard(nt, empty, i, ctx).question).replace(/\s+/g, '');
    if (filled && filled !== blank) ords.push(i);
  });
  return ords;
}
