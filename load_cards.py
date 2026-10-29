#!/usr/bin/env python3
"""Load every cards/**/*.json lesson file into anki.db (idempotent upsert).

Lesson file shape:
{
  "slug": "foundations/api-design", "part": "01 Fundamentals", "section": "02 Foundations",
  "title": "API Design", "url": "https://...", "summary": "...",
  "cards": [
    {"type": "basic", "front": "Q", "back": "A", "extra": "optional", "tags": ["rest"]},
    {"type": "cloze", "front": "Text with {{c1::deletion}}", "back": "optional back-extra", "tags": []}
  ]
}
"""
import datetime as dt
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "anki.db")
SCHEMA = os.path.join(ROOT, "schema.sql")
CARDS_DIR = os.path.join(ROOT, "cards")
DECK_ROOT = "System Design"


def slug_tag(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def guid_for(slug, front):
    return hashlib.sha1(f"{slug}|{front}".encode("utf-8")).hexdigest()[:16]


def load_lesson(conn, path, now):
    with open(path, encoding="utf-8") as fh:
        lesson = json.load(fh)
    for key in ("slug", "part", "section", "title", "url", "cards"):
        if key not in lesson:
            raise SystemExit(f"{path}: missing '{key}'")

    deck_name = f"{DECK_ROOT}::{lesson['part']}::{lesson['section']}"
    conn.execute("INSERT OR IGNORE INTO decks(name) VALUES (?)", (deck_name,))
    deck_id = conn.execute("SELECT id FROM decks WHERE name = ?", (deck_name,)).fetchone()[0]

    conn.execute(
        """INSERT INTO sources(slug, part, section, title, url, deck_id, summary, scraped_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(slug) DO UPDATE SET part=excluded.part, section=excluded.section,
             title=excluded.title, url=excluded.url, deck_id=excluded.deck_id,
             summary=excluded.summary, scraped_at=excluded.scraped_at""",
        (lesson["slug"], lesson["part"], lesson["section"], lesson["title"], lesson["url"],
         deck_id, lesson.get("summary"), lesson.get("scraped_at", now[:10])),
    )
    source_id = conn.execute("SELECT id FROM sources WHERE slug = ?", (lesson["slug"],)).fetchone()[0]

    base_tags = ["hellointerview", slug_tag(lesson["part"]), slug_tag(lesson["section"]),
                 "lesson-" + slug_tag(lesson["slug"].split("/")[-1])]
    seen = set()
    for pos, card in enumerate(lesson["cards"], start=1):
        ctype = card.get("type", "basic")
        if ctype not in ("basic", "cloze"):
            raise SystemExit(f"{path}: card {pos} has bad type {ctype!r}")
        front, back = card["front"].strip(), card.get("back", "").strip()
        if not front or (ctype == "basic" and not back):
            raise SystemExit(f"{path}: card {pos} is missing front/back")
        if ctype == "cloze" and "{{c1::" not in front:
            raise SystemExit(f"{path}: cloze card {pos} has no {{{{c1::}}}} deletion")
        guid = guid_for(lesson["slug"], front)
        if guid in seen:
            raise SystemExit(f"{path}: duplicate front at card {pos}: {front[:60]!r}")
        seen.add(guid)
        tags = " ".join(dict.fromkeys(base_tags + [slug_tag(t) for t in card.get("tags", [])]))
        conn.execute(
            """INSERT INTO cards(guid, source_id, deck_id, card_type, front, back, extra, tags,
                                 position, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(guid) DO UPDATE SET source_id=excluded.source_id, deck_id=excluded.deck_id,
                 card_type=excluded.card_type, back=excluded.back, extra=excluded.extra,
                 tags=excluded.tags, position=excluded.position, updated_at=excluded.updated_at""",
            (guid, source_id, deck_id, ctype, front, back, card.get("extra"), tags, pos, now, now),
        )
    # Cards removed from the JSON disappear from the DB too, so the file stays the source of truth.
    placeholders = ",".join("?" * len(seen)) or "''"
    conn.execute(f"DELETE FROM cards WHERE source_id = ? AND guid NOT IN ({placeholders})",
                 (source_id, *seen))
    return lesson["title"], len(seen)


def main():
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    conn = sqlite3.connect(DB)
    with open(SCHEMA, encoding="utf-8") as fh:
        conn.executescript(fh.read())
    files = sorted(glob.glob(os.path.join(CARDS_DIR, "**", "*.json"), recursive=True))
    if not files:
        raise SystemExit("no lesson files under cards/")
    total = 0
    for path in files:
        title, n = load_lesson(conn, path, now)
        total += n
        print(f"{n:4d}  {title}  ({os.path.relpath(path, ROOT)})")
    conn.commit()
    cards = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    sources = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    print(f"\n{cards} cards across {sources} lessons in {os.path.relpath(DB, ROOT)}")
    conn.close()


if __name__ == "__main__":
    main()
