import type { Notetype } from './types';

export const DEFAULT_CSS = `.card {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}`;

const CLOZE_CSS = `${DEFAULT_CSS}
.cloze { font-weight: bold; color: blue; }
.nightMode .cloze { color: lightblue; }`;

const EXTRA_CSS = `.card {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 19px;
  line-height: 1.5;
  text-align: left;
  color: black;
  background-color: white;
}
.front { font-weight: 600; }
.extra { margin-top: 1em; padding: .6em .8em; border-left: 3px solid #8888; opacity: .85; font-size: .9em; }
.cloze { font-weight: bold; color: blue; }
.nightMode .cloze { color: lightblue; }`;

// Fixed ids so built-in notetypes are shared across imports.
export const NT_BASIC = 1;
export const NT_REVERSED = 2;
export const NT_CLOZE = 3;
export const NT_BASIC_EXTRA = 4;
export const NT_CLOZE_TEXT = 5;

export function builtinNotetypes(now: number): Notetype[] {
  return [
    {
      id: NT_BASIC,
      name: 'Basic',
      kind: 'standard',
      fields: ['Front', 'Back'],
      templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }],
      css: DEFAULT_CSS,
      sortField: 0,
      mod: now,
    },
    {
      id: NT_REVERSED,
      name: 'Basic (and reversed card)',
      kind: 'standard',
      fields: ['Front', 'Back'],
      templates: [
        { name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' },
        { name: 'Card 2', qfmt: '{{Back}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}' },
      ],
      css: DEFAULT_CSS,
      sortField: 0,
      mod: now,
    },
    {
      id: NT_CLOZE,
      name: 'Cloze',
      kind: 'cloze',
      fields: ['Text', 'Back Extra'],
      templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }],
      css: CLOZE_CSS,
      sortField: 0,
      mod: now,
    },
    {
      id: NT_BASIC_EXTRA,
      name: 'Basic (with extra)',
      kind: 'standard',
      fields: ['Front', 'Back', 'Extra'],
      templates: [
        {
          name: 'Card 1',
          qfmt: '<div class="front">{{Front}}</div>',
          afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}\n{{#Extra}}<div class="extra">{{Extra}}</div>{{/Extra}}',
        },
      ],
      css: EXTRA_CSS,
      sortField: 0,
      mod: now,
    },
    {
      id: NT_CLOZE_TEXT,
      name: 'Cloze (with extra)',
      kind: 'cloze',
      fields: ['Text', 'Back Extra', 'Extra'],
      templates: [
        {
          name: 'Cloze',
          qfmt: '{{cloze:Text}}',
          afmt: '{{cloze:Text}}\n{{#Back Extra}}<hr id=answer>{{Back Extra}}{{/Back Extra}}\n{{#Extra}}<div class="extra">{{Extra}}</div>{{/Extra}}',
        },
      ],
      css: EXTRA_CSS,
      sortField: 0,
      mod: now,
    },
  ];
}
