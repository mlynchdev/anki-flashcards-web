# System Design Anki cards

Flashcards distilled from the Hello Interview System Design course
(https://www.hellointerview.com/learn/courses/system-design), covering the
Delivery Framework, all of **Part 1 · Fundamentals** and all of **Part 2 · The Patterns**
(every long-form lesson, review and deep dive; quizzes and interactive practice
sessions are not included).

## Layout

| Path | What it is |
|---|---|
| `anki.db` | SQLite database holding every card. This is the artifact to consume. |
| `schema.sql` | The schema (`decks`, `sources`, `cards`, and the `cards_v` view). |
| `cards/**/*.json` | One JSON file per lesson: the editable source of truth for the cards. |
| `load_cards.py` | Rebuilds/refreshes `anki.db` from the JSON files (idempotent upsert by `guid`). |

## Schema

- `decks(id, name, description)` — Anki-style hierarchical deck names, e.g.
  `System Design::02 The Patterns::05 Scaling Writes`.
- `sources(id, slug, part, section, title, url, deck_id, summary, scraped_at)` — one row per
  course lesson; `summary` is a one-paragraph gist of the lesson.
- `cards(id, guid, source_id, deck_id, card_type, front, back, extra, tags, position, ...)`
  - `card_type` is `basic` (front = question, back = answer) or `cloze`
    (front holds `{{c1::...}}` deletions in Anki syntax, back is the "extra" shown on reveal).
  - `extra` is an optional elaboration or interview tip.
  - `tags` is a space-separated Anki tag string. Every card carries `hellointerview`,
    its part, its section, and a `lesson-<slug>` tag, plus topical tags.
  - `position` is the card's order within its lesson.
- `cards_v` — convenience view joining everything: deck, part, section, lesson, url, card fields.

## Reading the cards

```bash
sqlite3 anki.db "SELECT deck, COUNT(*) FROM cards_v GROUP BY deck;"
sqlite3 anki.db "SELECT front, back FROM cards_v WHERE lesson = 'Kafka';"
sqlite3 anki.db "SELECT front FROM cards WHERE tags LIKE '%idempotency%';"
```

## Editing cards

Edit the relevant `cards/**/*.json` file, then run:

```bash
python3 load_cards.py
```

Cards are keyed by a hash of `(lesson slug, front)`, so edits to a card's back, extra or
tags update in place, new cards are added, and cards removed from the JSON are removed from
the database. Changing a card's front creates a new card (and retires the old one).
