"""Cross-language parity check: the whole point of using SQLite FTS5 (not an
embedding model) is that Python and TypeScript rank identically off the same
SQL, given the same catalog. This loads the same bench fixtures the TS
harness (bench/run.mjs) uses and asserts Python's recall@3 matches — if it
ever drifts, the "one ranking implementation, two languages" claim is false.
"""

import json
import sqlite3
from pathlib import Path

from skilljit import Catalog

BENCH_DIR = Path(__file__).resolve().parents[2] / "bench"


def _build_db(tmp_path: Path) -> Path:
    catalog_fixture = json.loads((BENCH_DIR / "fixtures" / "catalog.json").read_text())
    db_path = tmp_path / "bench-catalog.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE skills (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
          description TEXT NOT NULL, body TEXT NOT NULL,
          install_count INTEGER, audit_status TEXT, updated_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE skills_fts USING fts5(
          id UNINDEXED, name, description, tokenize = 'porter unicode61'
        );
        """
    )
    for s in catalog_fixture:
        conn.execute(
            "INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (s["id"], s["name"], s["source"], s["description"], "body", None, None, "2026-01-01T00:00:00.000Z"),
        )
        conn.execute(
            "INSERT INTO skills_fts (id, name, description) VALUES (?, ?, ?)",
            (s["id"], s["name"], s["description"]),
        )
    conn.commit()
    conn.close()
    return db_path


def test_python_recall_matches_typescript_bench(tmp_path: Path):
    dataset = json.loads((BENCH_DIR / "dataset.json").read_text())
    db_path = _build_db(tmp_path)

    with Catalog(db_path) as catalog:
        hits_at_3 = 0
        for item in dataset:
            results = catalog.search_skills(item["query"], limit=3)
            if any(r.skill.id == item["expectedId"] for r in results):
                hits_at_3 += 1

    recall_at_3 = hits_at_3 / len(dataset)
    # The TS bench (bench/run.mjs) measured recall@3 = 38/41 (~92.7%) on this
    # exact fixture set. Same SQL, same tokenizer config -> same number.
    assert hits_at_3 == 38
    assert recall_at_3 == 38 / 41
