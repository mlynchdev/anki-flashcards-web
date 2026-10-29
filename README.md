# Anki Flashcards Web

An open-source spaced repetition app that runs entirely in the browser. It is modeled on
AnkiMobile: hierarchical decks, the same study flow and rating buttons, Anki search syntax,
FSRS scheduling. It installs as a PWA on iOS, Android and desktop and works offline.

Live at **https://anki-sd.edgelord.dev**, behind Cloudflare Access. The fallback
`anki-flashcards-web.mark-cfc.workers.dev` URL serves the same Worker and is also behind Access.

The app works offline from IndexedDB. Deployed on Cloudflare, it adds three things:
- Deck content is served from a D1 database.
- Your review history and scheduling state sync through a per-user Durable Object.
- Cloudflare Access protects the whole Worker, so only you can sign in.

Served from any static host it runs local-only, and you import your own files. No card content
ships with the app or the repository.

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
- Study a parent deck as one shuffled pool. In the parent's options, set "New card gather order"
  to "Random cards" and "Review sort order" to "Random (across subdecks)". New cards and
  reviews from every subdeck are then mixed instead of arriving one section at a time. The
  shuffle stays stable for the day, and each subdeck's daily limits still apply.
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
src/sync/       sync protocol and client
worker/         Cloudflare Worker: Access JWT check, D1 content API, UserState Durable Object
src/ui/         screens (Preact)
tests/          unit tests
```

## Cloudflare deployment: D1, Durable Object sync, Access

```
browser (IndexedDB, works offline)
   │  GET /api/content   ──► Worker ──► D1 "anki-content" (decks / sources / cards)
   │  POST /api/sync     ──► Worker ──► Durable Object UserState, one per Access email (SQLite)
   │  everything else    ──► Worker ──► static assets (dist/)
   └─ every request first passes Cloudflare Access; the Worker re-verifies the Access JWT
```

### Worker (`worker/`)
- `access.ts` verifies the `Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie,
  as an RS256 JWT. Keys come from `https://<TEAM_DOMAIN>/cdn-cgi/access/certs`. It checks the
  AUD tag, the issuer and the expiry. It also checks that the email is in `ALLOWED_EMAILS`.
- `index.ts` runs before static assets (`run_worker_first`), so the UI is gated too. It fails
  closed: if `TEAM_DOMAIN` or `POLICY_AUD` is empty, every request gets a 403. Preview URLs are
  disabled.
- `syncStore.ts` is the Durable Object's store, using SQLite storage. Each record is keyed by
  `(store, id)` and carries the client's change time and a server sequence number.

### Sync rules
- The client journals every local change: cards, notes, decks, presets, note types, review log
  and settings, each with a timestamp.
- A sync pushes the journal, then pulls everything with a newer server sequence that another
  client wrote.
- Conflicts are last-write-wins per record, by change time. Review-log entries are immutable,
  except that undo deletes them with a tombstone.
- Defaults created by a fresh browser, and cards created from D1 content, are journaled with
  timestamp 1. Any synced copy beats them, so opening the app on a new device never resets your
  progress.
- Content rows from D1 get deterministic deck, note and card ids, so every device agrees on
  them.
- Sync runs on start, 4 s after a change, every minute, when the browser comes back online and
  when the tab becomes visible. Offline changes stay in IndexedDB until then.
- Erasing local data (or clearing the browser) and reloading downloads everything again.
- Media files are not synced.

### One-time setup

```bash
npx wrangler login
npx wrangler d1 create anki-content            # put the id in wrangler.jsonc
npx wrangler d1 execute anki-content --remote --file=schema.sql
npm run deploy                                 # deploys fail-closed (403 everywhere)
```

Load the card store into D1. The generated SQL contains card text: keep it outside the repo and
delete it afterwards.

```bash
python3 scripts/anki-db-to-d1.py anki.db /tmp/anki-d1.sql
npx wrangler d1 execute anki-content --remote --file=/tmp/anki-d1.sql -y
rm /tmp/anki-d1.sql
```

Running the same commands later replaces the content. The script deletes the old rows first.
Notes are matched by GUID, so scheduling survives content edits.

Cloudflare Access (Zero Trust Free plan, up to 50 users):
1. Open Zero Trust in the dashboard (one.dash.cloudflare.com) and create a team on the Free plan
   if you don't have one. The team domain looks like `<team>.cloudflareaccess.com`.
2. In Workers & Pages, open `anki-flashcards-web`, go to Settings → Domains & Routes, and enable
   Cloudflare Access on the `workers.dev` route. This creates an Access application for the
   Worker.
3. In Zero Trust → Access → Applications, edit that application:
   - Policy: Allow, with Include → Emails set to your address.
   - Login methods: One-time PIN. To use GitHub, add it first under Settings → Authentication →
     Login methods.
4. Copy the application's AUD tag (Overview tab). Set `TEAM_DOMAIN` and `POLICY_AUD` in
   `wrangler.jsonc`, then run `npm run deploy`.

### Giving someone else access

The Worker only admits an email that both Cloudflare Access and `ALLOWED_EMAILS` allow. To add
a second person, e.g. `friend@other.org`:

1. In Zero Trust → Access → Applications, edit the application's policy. Under Include → Emails,
   add their address. The One-time PIN login works for any email domain.
2. In `wrangler.jsonc`, add the address to the comma-separated list, e.g.
   `"ALLOWED_EMAILS": "mark@marklynch.dev, friend@other.org"`. Case and spaces don't matter.
3. Run `npm run deploy`.

Each email gets its own Durable Object, so review history and scheduling are kept separately
per person. Deck content in D1 is shared.

To remove someone, delete the address in both places and redeploy. Their Durable Object keeps
its data until you delete it.

### Custom domain

`wrangler.jsonc` serves the Worker on `anki-sd.edgelord.dev` as a Workers Custom Domain
(`"routes": [{ "pattern": "anki-sd.edgelord.dev", "custom_domain": true }]`). The zone must be
on the same Cloudflare account. `wrangler deploy` creates the DNS record and certificate for that
one hostname and doesn't touch the zone's other records. Access is enabled for all of the
Worker's traffic, so the custom domain uses the same application and AUD tag. To confirm, check
that the `kid` in the login redirect equals `POLICY_AUD`.

Check that unauthenticated requests are rejected:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://anki-sd.edgelord.dev/api/content   # 302 (Access) or 403 (Worker)
```

Local development of the Worker uses `wrangler dev` with a local D1 and Durable Object. Put
`DEV_EMAIL=you@example.com` in `.dev.vars` (gitignored). That identity is honoured only for
`localhost` requests.

## The local card store

This repository also holds the tooling for a private SQLite card store (`schema.sql`,
`load_cards.py`). The data itself (`anki.db`, `cards/`) is gitignored and is never committed or
bundled into the build. Rebuild it with `python3 load_cards.py`, then import `anki.db` in the
app.

## Not implemented

- Sync with AnkiWeb. Between devices, the app syncs through its own Durable Object.
- Syncing media files. Images and audio from `.apkg` imports stay in the browser that imported them.
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
