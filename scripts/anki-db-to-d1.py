#!/usr/bin/env python3
"""Write INSERT statements for anki.db's decks/sources/cards, in a form D1 accepts.

Usage: python3 scripts/anki-db-to-d1.py anki.db OUT.sql
Then:  npx wrangler d1 execute anki-content --remote --file=OUT.sql && rm OUT.sql
The output contains card text: write it outside the repo (or to a gitignored path) and delete it after.
"""
import sqlite3
import sys


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(src, out):
    conn = sqlite3.connect(src)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("DELETE FROM cards; DELETE FROM sources; DELETE FROM decks;\n")
        for table in ("decks", "sources", "cards"):
            cur = conn.execute(f"SELECT * FROM {table} ORDER BY id")
            cols = ", ".join(d[0] for d in cur.description)
            for row in cur:
                fh.write(f"INSERT INTO {table} ({cols}) VALUES ({', '.join(lit(v) for v in row)});\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
