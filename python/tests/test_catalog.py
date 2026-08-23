from pathlib import Path

import pytest

from skilljit import Catalog


def test_get_skill_by_id(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        skill = catalog.get_skill("acme/repo/postgres-migrate")
        assert skill is not None
        assert skill.name == "postgres-migrate"
        assert "shadow table" in skill.body


def test_get_unknown_skill_returns_none(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        assert catalog.get_skill("nope/nope") is None


def test_search_finds_by_keyword(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        hits = catalog.search_skills("postgres migration", limit=8)
        assert len(hits) == 1
        assert hits[0].skill.name == "postgres-migrate"


def test_search_results_have_no_body_field(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        hits = catalog.search_skills("pdf", limit=8)
        assert not hasattr(hits[0].skill, "body")


def test_search_no_match_returns_empty(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        assert catalog.search_skills("zzz_nonexistent_xyz") == []


def test_count(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        assert catalog.count() == 2


def test_list_skill_meta(seeded_db: Path):
    with Catalog(seeded_db) as catalog:
        meta = catalog.list_skill_meta()
        assert sorted(name for name, _ in meta) == ["pdf-processing", "postgres-migrate"]


def test_missing_db_raises_clear_error(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="skilljit sync"):
        Catalog(tmp_path / "does-not-exist.db")
