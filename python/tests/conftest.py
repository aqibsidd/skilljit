import sqlite3
from pathlib import Path

import pytest

# Mirrors the schema created by @skilljit/core's Catalog (packages/core/src/catalog.ts).
# Kept minimal and independent so these tests don't require Node to run.
SCHEMA = """
CREATE TABLE skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
  files_json    TEXT,
  install_count INTEGER,
  audit_status  TEXT,
  updated_at    TEXT NOT NULL
);
CREATE VIRTUAL TABLE skills_fts USING fts5(
  id UNINDEXED, name, description, tokenize = 'porter unicode61'
);
"""


@pytest.fixture()
def seeded_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "catalog.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(SCHEMA)
    rows = [
        (
            "acme/repo/postgres-migrate",
            "postgres-migrate",
            "github:acme/repo",
            "Plan and run zero-downtime Postgres schema migrations.",
            "# Postgres migrations\n\nUse a shadow table.",
            None,
            42,
            "pass",
            "2026-01-01T00:00:00.000Z",
        ),
        (
            "acme/repo/pdf-processing",
            "pdf-processing",
            "github:acme/repo",
            "Extract text and tables from PDF files.",
            "# PDF processing\n\nUse pdfplumber.",
            None,
            None,
            None,
            "2026-01-01T00:00:00.000Z",
        ),
        (
            "acme/repo/docker-expert",
            "docker-expert",
            "github:acme/repo",
            "Write production Dockerfiles.",
            "# Docker\n\nSee references/checklist.md.",
            '[{"path": "references/checklist.md", "content": "- pin base image"}]',
            None,
            None,
            "2026-01-01T00:00:00.000Z",
        ),
    ]
    conn.executemany(
        "INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.executemany(
        "INSERT INTO skills_fts (id, name, description) VALUES (?, ?, ?)",
        [(r[0], r[1], r[3]) for r in rows],
    )
    conn.commit()
    conn.close()
    return db_path
