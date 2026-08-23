"""Read-only queries against the same ~/.skilljit/catalog.db the Node CLI
writes. This is deliberately thin: it does not reimplement ingestion or
ranking logic beyond the SQL itself, so `skilljit sync` (Node) stays the
single source of truth for what's in the catalog — this module just lets
Python agents (e.g. claude-agent-sdk) read it directly instead of shelling
out to the CLI for every lookup.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

from .paths import default_catalog_path

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _to_fts_query(query: str) -> Optional[str]:
    """Mirror of the TypeScript core's toFtsQuery: OR together quoted
    alphanumeric tokens, so both languages rank identically for the same
    query given the same catalog."""
    tokens = _TOKEN_RE.findall(query.lower())
    if not tokens:
        return None
    return " OR ".join(f'"{t}"' for t in tokens)


@dataclass(frozen=True)
class SkillMeta:
    id: str
    name: str
    source: str
    description: str
    install_count: Optional[int]
    audit_status: Optional[str]
    updated_at: str


@dataclass(frozen=True)
class SkillFile:
    path: str
    content: str


@dataclass(frozen=True)
class Skill(SkillMeta):
    body: str
    files: Optional[list[SkillFile]] = None


@dataclass(frozen=True)
class SkillSearchHit:
    skill: SkillMeta
    rank: float


class Catalog:
    """Read-only handle on the local skilljit catalog db. Raises a clear
    error (rather than a bare sqlite3.OperationalError) if the db is
    missing or if this Python build's sqlite3 lacks FTS5 — a small number
    of minimal Linux distro Python packages omit it."""

    def __init__(self, db_path: Union[str, Path, None] = None):
        path = Path(db_path) if db_path is not None else default_catalog_path()
        if not path.exists():
            raise FileNotFoundError(
                f"No skilljit catalog found at {path}. Run `skilljit sync` first "
                "(requires Node.js — see https://github.com/aqibsidd/skilljit)."
            )
        self._conn = sqlite3.connect(str(path))
        self._conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Catalog":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get_skill(self, skill_id: str) -> Optional[Skill]:
        row = self._conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if row is None:
            return None
        return _row_to_skill(row)

    def search_skills(self, query: str, limit: int = 8) -> list[SkillSearchHit]:
        fts_query = _to_fts_query(query)
        if fts_query is None:
            return []
        try:
            rows = self._conn.execute(
                """
                SELECT s.id, s.name, s.source, s.description, s.install_count, s.audit_status, s.updated_at,
                       bm25(skills_fts) AS rank
                FROM skills_fts
                JOIN skills s ON s.id = skills_fts.id
                WHERE skills_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (fts_query, limit),
            ).fetchall()
        except sqlite3.OperationalError as err:
            if "fts5" in str(err).lower():
                raise RuntimeError(
                    "This Python's sqlite3 was built without FTS5 support, so skilljit can't "
                    "search the catalog. Use the `skilljit` Node CLI/MCP server instead, or "
                    "install a Python build with FTS5 (most python.org and Homebrew builds have it)."
                ) from err
            raise
        return [
            SkillSearchHit(
                skill=SkillMeta(
                    id=row["id"],
                    name=row["name"],
                    source=row["source"],
                    description=row["description"],
                    install_count=row["install_count"],
                    audit_status=row["audit_status"],
                    updated_at=row["updated_at"],
                ),
                rank=row["rank"],
            )
            for row in rows
        ]

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM skills").fetchone()[0]

    def list_skill_meta(self) -> list[tuple[str, str]]:
        rows = self._conn.execute("SELECT name, description FROM skills").fetchall()
        return [(row["name"], row["description"]) for row in rows]


def _row_to_skill(row: sqlite3.Row) -> Skill:
    files_json = row["files_json"] if "files_json" in row.keys() else None
    files = [SkillFile(**f) for f in json.loads(files_json)] if files_json else None
    return Skill(
        id=row["id"],
        name=row["name"],
        source=row["source"],
        description=row["description"],
        body=row["body"],
        files=files,
        install_count=row["install_count"],
        audit_status=row["audit_status"],
        updated_at=row["updated_at"],
    )
