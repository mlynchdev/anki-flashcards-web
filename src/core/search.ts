// Anki search syntax: implicit AND, `or`, `-` negation, parentheses, quoted phrases,
// field:value terms (deck:, tag:, is:, flag:, rated:, prop:, added:, note:, card:, ...),
// `*` and `_` wildcards.
import { type Card, CardState, type Deck, type Note, type Notetype, type Revlog } from './types';
import { dayOf } from './time';
import { stripHtml } from './template';

export type SearchNode =
  | { type: 'and'; children: SearchNode[] }
  | { type: 'or'; children: SearchNode[] }
  | { type: 'not'; child: SearchNode }
  | { type: 'term'; key: string; value: string };

export class SearchError extends Error {}

type Token = { kind: 'lparen' | 'rparen' | 'or' | 'and' | 'not' } | { kind: 'term'; text: string };

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '-' && i + 1 < n && !/\s/.test(input[i + 1])) {
      tokens.push({ kind: 'not' });
      i++;
      continue;
    }
    // Read one term; quotes may appear at start ("a b") or after a colon (deck:"a b").
    let text = '';
    let quoted = false;
    while (i < n) {
      const c = input[i];
      if (c === '\\' && i + 1 < n) {
        text += c + input[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i++;
        while (i < n && input[i] !== '"') {
          if (input[i] === '\\' && i + 1 < n) {
            text += input[i] + input[i + 1];
            i += 2;
          } else text += input[i++];
        }
        i++; // closing quote
        continue;
      }
      if (/\s/.test(c) || c === '(' || c === ')') break;
      text += c;
      i++;
    }
    if (!quoted && /^or$/i.test(text)) tokens.push({ kind: 'or' });
    else if (!quoted && /^and$/i.test(text)) tokens.push({ kind: 'and' });
    else if (text.length) tokens.push({ kind: 'term', text });
  }
  return tokens;
}

export function parseSearch(input: string): SearchNode {
  const tokens = tokenize(input);
  let pos = 0;

  function parseOr(): SearchNode {
    const children = [parseAnd()];
    while (pos < tokens.length && tokens[pos].kind === 'or') {
      pos++;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0] : { type: 'or', children };
  }
  function parseAnd(): SearchNode {
    const children: SearchNode[] = [];
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind === 'rparen' || t.kind === 'or') break;
      if (t.kind === 'and') {
        pos++;
        continue;
      }
      children.push(parseUnary());
    }
    if (children.length === 0) throw new SearchError('Expected a search term');
    return children.length === 1 ? children[0] : { type: 'and', children };
  }
  function parseUnary(): SearchNode {
    const t = tokens[pos];
    if (t.kind === 'not') {
      pos++;
      if (pos >= tokens.length) throw new SearchError('Nothing to negate after "-"');
      return { type: 'not', child: parseUnary() };
    }
    if (t.kind === 'lparen') {
      pos++;
      const inner = parseOr();
      if (tokens[pos]?.kind !== 'rparen') throw new SearchError('Missing closing parenthesis');
      pos++;
      return inner;
    }
    if (t.kind === 'term') {
      pos++;
      return termNode(t.text);
    }
    throw new SearchError('Unexpected token');
  }

  if (tokens.length === 0) return { type: 'and', children: [] };
  const node = parseOr();
  if (pos < tokens.length) throw new SearchError('Unbalanced parentheses');
  return node;
}

function termNode(text: string): SearchNode {
  // An escaped colon (\:) is literal text, not a field separator.
  const m = /^((?:[^:\\]|\\.)+?):([\s\S]*)$/.exec(text);
  if (m && !text.startsWith(':')) {
    return { type: 'term', key: unescape(m[1]).toLowerCase(), value: m[2] };
  }
  return { type: 'term', key: '', value: text };
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** Converts an Anki glob (`*`, `_`, `\*` escapes) into a RegExp source. */
export function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      out += escapeRe(glob[++i]);
    } else if (c === '*') out += '.*';
    else if (c === '_') out += '.';
    else out += escapeRe(c);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export interface SearchEnv {
  now: number;
  today: number;
  rolloverHour: number;
  decks: Deck[];
  currentDeckId?: number;
  note(id: number): Note | undefined;
  notetype(id: number): Notetype | undefined;
  revlog(cardId: number): Revlog[];
  /** FSRS retrievability now, if the card has a memory state. */
  retrievability(card: Card): number | undefined;
  /** Day number when the card is next due (review/learning), or undefined. */
  dueDay(card: Card): number | undefined;
}

export type CardPredicate = (card: Card) => boolean;

export function compileSearch(query: string, env: SearchEnv): CardPredicate {
  return compileNode(parseSearch(query), env);
}

function compileNode(node: SearchNode, env: SearchEnv): CardPredicate {
  switch (node.type) {
    case 'and': {
      const parts = node.children.map((c) => compileNode(c, env));
      return (card) => parts.every((p) => p(card));
    }
    case 'or': {
      const parts = node.children.map((c) => compileNode(c, env));
      return (card) => parts.some((p) => p(card));
    }
    case 'not': {
      const p = compileNode(node.child, env);
      return (card) => !p(card);
    }
    case 'term':
      return compileTerm(node.key, node.value, env);
  }
}

const cmpOps: Record<string, (a: number, b: number) => boolean> = {
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
  '!=': (a, b) => a !== b,
  '=': (a, b) => Math.abs(a - b) < 1e-9,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
};

function noteText(note: Note): string {
  return note.fields.map(stripHtml).join('\u001f');
}

function compileTerm(key: string, rawValue: string, env: SearchEnv): CardPredicate {
  const value = unescape(rawValue);
  const lower = value.toLowerCase();
  switch (key) {
    case '': {
      const re = new RegExp(globToRegex(rawValue), 'i');
      return (card) => {
        const note = env.note(card.noteId);
        return !!note && re.test(noteText(note));
      };
    }
    case 'deck': {
      if (lower === '*') return () => true;
      let ids: Set<number>;
      if (lower === 'current' && env.currentDeckId !== undefined) {
        const cur = env.decks.find((d) => d.id === env.currentDeckId);
        ids = deckIdsMatching(env.decks, cur ? cur.name : '');
      } else if (lower === 'filtered') {
        ids = new Set(env.decks.filter((d) => d.dyn).map((d) => d.id));
      } else {
        ids = deckIdsMatching(env.decks, rawValue);
      }
      return (card) => ids.has(card.deckId) || (card.odid !== undefined && ids.has(card.odid));
    }
    case 'tag': {
      if (lower === 'none') {
        return (card) => (env.note(card.noteId)?.tags.length ?? 0) === 0;
      }
      const re = new RegExp(`^${globToRegex(rawValue)}(::.*)?$`, 'i');
      return (card) => !!env.note(card.noteId)?.tags.some((t) => re.test(t));
    }
    case 'is':
      return isTerm(lower, env);
    case 'flag': {
      const f = Number(value);
      if (!Number.isInteger(f) || f < 0 || f > 7) throw new SearchError(`Invalid flag: ${value}`);
      return (card) => card.flag === f;
    }
    case 'rated':
    case 'introduced':
    case 'added':
    case 'edited':
    case 'resched':
      return dateTerm(key, value, env);
    case 'prop':
      return propTerm(value, env);
    case 'note': {
      const re = new RegExp(`^${globToRegex(rawValue)}$`, 'i');
      return (card) => {
        const note = env.note(card.noteId);
        const nt = note && env.notetype(note.notetypeId);
        return !!nt && re.test(nt.name);
      };
    }
    case 'card': {
      const asNum = Number(value);
      const re = new RegExp(`^${globToRegex(rawValue)}$`, 'i');
      return (card) => {
        if (Number.isInteger(asNum) && asNum > 0) return card.ord === asNum - 1;
        const note = env.note(card.noteId);
        const nt = note && env.notetype(note.notetypeId);
        if (!nt) return false;
        const name = nt.kind === 'cloze' ? `Cloze ${card.ord + 1}` : nt.templates[card.ord]?.name ?? '';
        return re.test(name);
      };
    }
    case 'nid': {
      const ids = new Set(value.split(',').map(Number));
      return (card) => ids.has(card.noteId);
    }
    case 'cid': {
      const ids = new Set(value.split(',').map(Number));
      return (card) => ids.has(card.id);
    }
    case 're': {
      const re = new RegExp(value, 'i');
      return (card) => {
        const note = env.note(card.noteId);
        return !!note && re.test(noteText(note));
      };
    }
    case 'w': {
      const re = new RegExp(`\\b${globToRegex(rawValue)}\\b`, 'i');
      return (card) => {
        const note = env.note(card.noteId);
        return !!note && re.test(noteText(note));
      };
    }
    case 'dupe':
      throw new SearchError('dupe: searches are not supported');
    default: {
      // field:value - whole-field glob match on the named field.
      const re = new RegExp(`^${globToRegex(rawValue)}$`, 'is');
      const fieldRe = new RegExp(`^${globToRegex(key)}$`, 'i');
      return (card) => {
        const note = env.note(card.noteId);
        const nt = note && env.notetype(note.notetypeId);
        if (!note || !nt) return false;
        return nt.fields.some((f, i) => fieldRe.test(f) && re.test(stripHtml(note.fields[i] ?? '')));
      };
    }
  }
}

export function deckIdsMatching(decks: Deck[], pattern: string): Set<number> {
  const re = new RegExp(`^${globToRegex(pattern)}(::.*)?$`, 'i');
  return new Set(decks.filter((d) => re.test(d.name)).map((d) => d.id));
}

function isTerm(what: string, env: SearchEnv): CardPredicate {
  switch (what) {
    case 'new':
      return (c) => c.state === CardState.New;
    case 'learn':
      return (c) => c.state === CardState.Learning || c.state === CardState.Relearning;
    case 'review':
      return (c) => c.state === CardState.Review || c.state === CardState.Relearning;
    case 'due':
      return (c) => {
        if (c.suspended || c.buried) return false;
        if (c.state === CardState.Review) return c.due <= env.today;
        if (c.state === CardState.Learning || c.state === CardState.Relearning) {
          return dayOf(c.due, env.rolloverHour) <= env.today;
        }
        return false;
      };
    case 'suspended':
      return (c) => c.suspended;
    case 'buried':
      return (c) => c.buried > 0;
    case 'buried-sibling':
      return (c) => c.buried === 1;
    case 'buried-manually':
      return (c) => c.buried === 2;
    case 'marked':
      return (c) => !!env.note(c.noteId)?.tags.some((t) => t.toLowerCase() === 'marked');
    case 'leech':
      return (c) => !!env.note(c.noteId)?.tags.some((t) => t.toLowerCase() === 'leech');
    case 'flagged':
      return (c) => c.flag > 0;
    default:
      throw new SearchError(`Unknown is: search "${what}"`);
  }
}

function dateTerm(key: string, value: string, env: SearchEnv): CardPredicate {
  const [daysStr, easeStr] = value.split(':');
  const days = Number(daysStr);
  if (!Number.isInteger(days) || days < 1) throw new SearchError(`${key}: needs a positive number of days`);
  const firstDay = env.today - days + 1;
  const inRange = (ts: number) => dayOf(ts, env.rolloverHour) >= firstDay;
  switch (key) {
    case 'rated': {
      const ease = easeStr ? Number(easeStr) : undefined;
      return (c) => env.revlog(c.id).some((r) => r.ease > 0 && inRange(r.id) && (ease === undefined || r.ease === ease));
    }
    case 'resched':
      return (c) => env.revlog(c.id).some((r) => r.ease === 0 && inRange(r.id));
    case 'introduced':
      return (c) => {
        const first = env.revlog(c.id).find((r) => r.ease > 0);
        return !!first && inRange(first.id);
      };
    case 'added':
      return (c) => inRange(c.noteId > 1e11 ? c.noteId : c.id);
    case 'edited':
      return (c) => {
        const n = env.note(c.noteId);
        return !!n && inRange(n.mod);
      };
  }
  return () => false;
}

function propTerm(value: string, env: SearchEnv): CardPredicate {
  const m = /^([a-z]+)(<=|>=|!=|=|<|>)(-?[\d.]+)$/i.exec(value);
  if (!m) throw new SearchError(`Invalid prop: search "${value}"`);
  const [, prop, op, numStr] = m;
  const num = Number(numStr);
  const cmp = cmpOps[op];
  switch (prop.toLowerCase()) {
    case 'ivl':
      return (c) => c.state !== CardState.New && cmp(c.ivl, num);
    case 'due':
      return (c) => {
        const d = env.dueDay(c);
        return d !== undefined && cmp(d - env.today, num);
      };
    case 'reps':
      return (c) => cmp(c.reps, num);
    case 'lapses':
      return (c) => cmp(c.lapses, num);
    case 'ease':
      return (c) => c.state !== CardState.New && cmp(c.ease, num);
    case 'pos':
      return (c) => c.state === CardState.New && cmp(c.due, num);
    case 's':
      return (c) => c.stability !== undefined && cmp(c.stability, num);
    case 'd':
      // Anki exposes difficulty on a 0-1 scale.
      return (c) => c.difficulty !== undefined && cmp((c.difficulty - 1) / 9, num);
    case 'r':
      return (c) => {
        const r = env.retrievability(c);
        return r !== undefined && cmp(r, num);
      };
    default:
      throw new SearchError(`Unknown property "${prop}"`);
  }
}
