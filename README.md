# Anki Flashcards Web

An open-source spaced repetition app that runs entirely in the browser. It is modeled on
AnkiMobile: hierarchical decks, the same study flow and rating buttons, Anki search syntax,
FSRS scheduling. It installs as a PWA on iOS, Android and desktop and works offline.

There is no server and no account. You import your own decks; cards and review history are
stored in the browser's IndexedDB and never leave the device. No card content ships with the
app.

## Features

**Scheduling**
- FSRS-6 (Anki's current default), ported from ts-fsrs and checked against it in tests. SM-2
  (Anki's legacy algorithm) can be selected in Settings.
- Learning and relearning steps follow Anki's rules: Hard on the first step averages the first
  two steps, and interday steps are due at the start of a day.
- Again / Hard / Good / Easy, with the next interval shown on each button. Fuzz is seeded per
  card, so the preview matches the interval you actually get.
- New and review daily limits apply per deck and to parent decks. By default the review limit
  also caps new cards, as in Anki v3. Custom Study can raise today's limits.
- Configurable day rollover hour, learn-ahead limit and maximum interval.
- Leech threshold, with tag-only or suspend as the action.
- Sibling burying (new, review and interday-learning siblings), with automatic unbury at day
  rollover.
- Desired retention and FSRS parameters per preset. "Optimize parameters" fits the 21 FSRS
  weights to your review history in a Web Worker.
- SM-2 options: starting ease, easy bonus, interval modifier, hard interval, lapse multiplier,
  minimum interval.

**Studying**
- Deck list with collapsible subdecks and new / learning / due counts.
- Study screen: show answer, rating buttons, remaining counts with the current queue
  underlined. Answer time is recorded per card, capped at 60 s.
- Tap zones (left / center / right, separately for question and answer side) and swipe gestures
  (left / right / up / down). All are configurable.
- Desktop keyboard shortcuts: space/enter, 1–4, `u` undo, `e` edit, `i` card info, `-` / `=`
  bury card / note, `@` / `!` suspend card / note, `*` mark, Ctrl+1–7 flags, `r` replay audio.
- Multi-level undo.
- Flags (7 colours), mark, bury, suspend, reset to new, set due date, delete, edit the current
  note, and card info with the full review history.
- Cloze deletions (`{{c1::text::hint}}`), Anki templates (`{{Field}}`, `{{FrontSide}}`,
  conditionals, `cloze:`, `hint:`, `text:`, `furigana:`), and note type CSS isolated in a
  shadow DOM.
- Images and `[sound:…]` audio from imported packages.

**Browse and edit**
- Browser with Anki search syntax: `deck:`, `tag:`, `is:due|new|learn|review|suspended|buried|marked|leech`,
  `flag:`, `rated:n[:ease]`, `introduced:`, `added:`, `edited:`, `prop:ivl|due|reps|lapses|ease|pos|s|d|r`,
  `note:`, `card:`, `nid:`, `cid:`, `re:`, `w:`, `field:value`, wildcards, `or`, `-`, parentheses.
- Sort by date added, due, sort field, interval, ease, reviews, lapses or modified. Toggle
  between a cards view and a notes view.
- Bulk actions: suspend, bury, flag, change deck, add / remove tags, mark, set due date (also as
  a range), reposition, forget, delete, export, and creating a filtered deck from the selection.
- Add and edit notes with Basic, Basic (and reversed card), Cloze, or any imported note type,
  with a cloze button, a tag input with autocomplete and a live preview.
- Tags screen: rename (child tags are renamed too) and delete.
- Note type editor: rename and add fields, edit templates and CSS, add card types, clone.

**Decks**
- Option presets shared between decks: clone, rename, remove, apply to subdecks.
- Filtered decks with any search, a limit, an order (random, due, added, interval, lapses,
  lowest retrievability), and rescheduling on or off (off is preview mode). Rebuild and empty.
- Custom Study: extra new cards, extra reviews, forgotten cards, review ahead, preview new
  cards, cram, weakest cards.

**Statistics**: today, future due forecast, reviews per day (count or time), card counts,
interval / ease / difficulty / stability / retrievability distributions, a calendar heatmap with
streaks, hourly breakdown, answer buttons, true retention table. Each can be scoped to a deck
and a period.

**Settings**: theme (system / light / dark), card font size, scheduler, button intervals,
remaining count, fuzz, rollover hour, learn-ahead, gesture mapping.

## Import and export

| Format | Notes |
|---|---|
| `.apkg` / `.colpkg` | Anki packages, both the legacy (`collection.anki2/anki21`) and the current zstd format (`collection.anki21b`). Imports notes, note types, decks, legacy deck options, scheduling state including FSRS memory, review history and media. |
| `.anki2` | A bare Anki collection file. |
| `.db` | The SQLite card store described in `schema.sql` (`decks`, `sources`, `cards`). Plain text is converted to HTML. |
| `.csv` / `.txt` | Delimiter is detected automatically. Anki's `#separator`, `#html`, `#tags column` and `#deck column` headers are honoured. |
| `.json` | A backup made by this app (replace or merge). |

Re-importing a file updates notes that have the same GUID instead of duplicating them.

The app exports a full backup (JSON, including review history and media), a per-deck backup,
and notes as tab-separated text that Anki can import.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: scheduler, FSRS, search, collection, importers, stats, optimizer
npm run typecheck
npm run build      # outputs dist/ and fails if any deck data file ended up in it
```

The stack is Vite, Preact and TypeScript. The other dependencies are sql.js (reading SQLite in
the browser), fflate and fzstd (unpacking Anki packages), idb and DOMPurify. ts-fsrs is a dev
dependency, used only to cross-check the FSRS port.

```
src/core/       data model, FSRS + SM-2 scheduler, search parser, collection store, stats, optimizer
src/importers/  apkg/colpkg, card store .db, CSV, JSON backup
src/ui/         screens (Preact)
tests/          unit tests
```

## Deploy (Cloudflare Workers static assets)

```bash
npx wrangler login     # once
npm run deploy         # build + wrangler deploy
```

`wrangler.jsonc` serves `dist/` as static assets with single-page-app fallback. The app is fully
static, so any static host works.

## The local card store

This repository also holds the tooling for a private SQLite card store (`schema.sql`,
`load_cards.py`). The data itself (`anki.db`, `cards/`) is gitignored and is never committed or
bundled into the build. Rebuild it with `python3 load_cards.py`, then import `anki.db` in the
app.

## Not implemented

- Sync with AnkiWeb or between devices. Use backup and import to move data.
- Exporting `.apkg` packages. Export is JSON or tab-separated text.
- Image occlusion, type-in-the-answer comparison, TTS, LaTeX/MathJax rendering, and card
  JavaScript (scripts are stripped for safety).
- Nested cloze deletions.
- Removing fields or card types from note types, and changing the note type of existing notes
  from the UI.
- Deck options from the new Anki package format (`.anki21b`). Those decks get the default
  preset.
- Some advanced FSRS features: the retention simulator, rescheduling all cards when
  parameters change, and "ignore reviews before".

## License

MIT
