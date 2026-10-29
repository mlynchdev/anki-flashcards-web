-- Anki-style flashcard store built from the Hello Interview System Design course.
-- Load/refresh with:  python3 load_cards.py
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,       -- Anki hierarchical name, e.g. "System Design::01 Fundamentals::02 Foundations"
  description TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,       -- course lesson slug, e.g. "foundations/api-design"
  part        TEXT NOT NULL,              -- "01 Fundamentals" | "02 The Patterns"
  section     TEXT NOT NULL,              -- "02 Foundations", "04 Scaling Reads", ...
  title       TEXT NOT NULL,              -- lesson title as shown in the sidebar
  url         TEXT NOT NULL,
  deck_id     INTEGER NOT NULL REFERENCES decks(id),
  summary     TEXT,                       -- one-paragraph gist of the lesson
  scraped_at  TEXT NOT NULL               -- ISO date the lesson was read
);

CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY,
  guid        TEXT NOT NULL UNIQUE,       -- stable hash of (slug, front); lets reloads upsert instead of duplicate
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  deck_id     INTEGER NOT NULL REFERENCES decks(id),
  card_type   TEXT NOT NULL CHECK (card_type IN ('basic', 'cloze')),
  front       TEXT NOT NULL,              -- basic: the question.  cloze: text with {{c1::...}} deletions
  back        TEXT NOT NULL,              -- basic: the answer.    cloze: the "back extra" shown after reveal
  extra       TEXT,                       -- optional elaboration / why it matters / interview tip
  tags        TEXT NOT NULL DEFAULT '',   -- space-separated Anki tags
  position    INTEGER NOT NULL,           -- order within the source lesson
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_source ON cards(source_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_deck   ON cards(deck_id);

-- Convenience view: one row per card with its deck and lesson spelled out.
CREATE VIEW IF NOT EXISTS cards_v AS
SELECT c.id, d.name AS deck, s.part, s.section, s.title AS lesson, s.url,
       c.card_type, c.front, c.back, c.extra, c.tags, c.position
FROM cards c
JOIN sources s ON s.id = c.source_id
JOIN decks d   ON d.id = c.deck_id
ORDER BY s.part, s.section, s.slug, c.position;
