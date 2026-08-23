import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Catalog } from "../src/catalog.js";
import type { SkillRecord } from "../src/types.js";

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "acme/repo/pdf-processing",
    name: "pdf-processing",
    source: "github:acme/repo",
    description:
      "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files.",
    body: "# PDF processing\n\nUse pdfplumber to extract text.",
    installCount: 42,
    auditStatus: "pass",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Catalog", () => {
  let dbPath: string;
  let catalog: Catalog;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-")), "catalog.db");
    catalog = new Catalog(dbPath);
  });

  afterEach(() => {
    catalog.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("upserts and retrieves a skill by id", () => {
    catalog.upsertSkills([makeSkill()]);
    const found = catalog.getSkill("acme/repo/pdf-processing");
    expect(found?.name).toBe("pdf-processing");
    expect(found?.body).toContain("pdfplumber");
  });

  it("upsert is idempotent — re-inserting updates, not duplicates", () => {
    catalog.upsertSkills([makeSkill()]);
    catalog.upsertSkills([makeSkill({ description: "Updated description mentioning PDFs" })]);
    expect(catalog.count()).toBe(1);
    expect(catalog.getSkill("acme/repo/pdf-processing")?.description).toContain("Updated");
  });

  it("finds a skill by keyword match in description", () => {
    catalog.upsertSkills([
      makeSkill(),
      makeSkill({
        id: "acme/repo/postgres-migrate",
        name: "postgres-migrate",
        description: "Plan and run zero-downtime Postgres schema migrations.",
        body: "# Postgres migrations",
      }),
    ]);
    const hits = catalog.searchSkills("postgres migration", 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skill.name).toBe("postgres-migrate");
  });

  it("search results omit the full body (cheap candidates only)", () => {
    catalog.upsertSkills([makeSkill()]);
    const hits = catalog.searchSkills("pdf", 8);
    expect((hits[0].skill as any).body).toBeUndefined();
  });

  it("returns no hits for a query that matches nothing", () => {
    catalog.upsertSkills([makeSkill()]);
    const hits = catalog.searchSkills("zzz_nonexistent_xyz", 8);
    expect(hits.length).toBe(0);
  });

  it("respects the limit parameter", () => {
    const skills = Array.from({ length: 20 }, (_, i) =>
      makeSkill({ id: `acme/repo/skill-${i}`, name: `skill-${i}`, description: "csv processing tool " + i }),
    );
    catalog.upsertSkills(skills);
    const hits = catalog.searchSkills("csv processing", 5);
    expect(hits.length).toBe(5);
  });

  it("lists total skill count", () => {
    catalog.upsertSkills([makeSkill(), makeSkill({ id: "x/y/z", name: "z" })]);
    expect(catalog.count()).toBe(2);
  });

  it("lists name+description metadata for every skill, without bodies", () => {
    catalog.upsertSkills([makeSkill(), makeSkill({ id: "x/y/z", name: "z", description: "zzz" })]);
    const meta = catalog.listSkillMeta();
    expect(meta).toHaveLength(2);
    expect(meta.map((m) => m.name).sort()).toEqual(["pdf-processing", "z"]);
    expect((meta[0] as any).body).toBeUndefined();
  });

  it("persists across reopening the same db file", () => {
    catalog.upsertSkills([makeSkill()]);
    catalog.close();
    const reopened = new Catalog(dbPath);
    expect(reopened.count()).toBe(1);
    reopened.close();
  });

  it("round-trips bundled files on a skill", () => {
    catalog.upsertSkills([
      makeSkill({ files: [{ path: "references/checklist.md", content: "- step one" }] }),
    ]);
    const found = catalog.getSkill("acme/repo/pdf-processing");
    expect(found?.files).toEqual([{ path: "references/checklist.md", content: "- step one" }]);
  });

  it("a skill with no bundled files round-trips with files left undefined", () => {
    catalog.upsertSkills([makeSkill()]);
    const found = catalog.getSkill("acme/repo/pdf-processing");
    expect(found?.files).toBeUndefined();
  });

  it("search hits never carry bundled file content, even when the skill has files", () => {
    catalog.upsertSkills([
      makeSkill({ files: [{ path: "references/checklist.md", content: "- step one" }] }),
    ]);
    const hits = catalog.searchSkills("pdf", 8);
    expect((hits[0].skill as any).files).toBeUndefined();
  });

  it("opens a pre-existing catalog.db created before files_json existed, without crashing", () => {
    catalog.close();
    // Simulate a catalog created by an older skilljit version: same file,
    // but drop the files_json column skilljit@0.1.2+ expects.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`ALTER TABLE skills RENAME TO skills_new`);
    legacyDb.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
        description TEXT NOT NULL, body TEXT NOT NULL,
        install_count INTEGER, audit_status TEXT, updated_at TEXT NOT NULL
      )
    `);
    legacyDb.exec(`
      INSERT INTO skills (id, name, source, description, body, install_count, audit_status, updated_at)
      SELECT id, name, source, description, body, install_count, audit_status, updated_at FROM skills_new
    `);
    legacyDb.exec(`DROP TABLE skills_new`);
    legacyDb.close();

    const reopened = new Catalog(dbPath);
    expect(reopened.count()).toBe(0);
    reopened.upsertSkills([makeSkill({ files: [{ path: "a.md", content: "x" }] })]);
    expect(reopened.getSkill("acme/repo/pdf-processing")?.files).toEqual([{ path: "a.md", content: "x" }]);
    reopened.close();
  });

  it("starts with zeroed-out global ledger totals", () => {
    expect(catalog.getGlobalLedgerTotals()).toEqual({ baselineTokens: 0, actualTokens: 0, sessionCount: 0 });
  });

  it("accumulates global ledger deltas across calls", () => {
    catalog.addGlobalLedgerBaseline(100);
    catalog.addGlobalLedgerBaseline(50);
    catalog.addGlobalLedgerActual(10);
    expect(catalog.getGlobalLedgerTotals()).toMatchObject({ baselineTokens: 150, actualTokens: 10 });
  });

  it("counts one session per recordGlobalSessionStart call", () => {
    catalog.recordGlobalSessionStart();
    catalog.recordGlobalSessionStart();
    expect(catalog.getGlobalLedgerTotals().sessionCount).toBe(2);
  });

  it("global ledger totals survive reopening the db (simulating a second tab)", () => {
    catalog.addGlobalLedgerBaseline(200);
    catalog.addGlobalLedgerActual(20);
    catalog.recordGlobalSessionStart();
    catalog.close();

    const secondTab = new Catalog(dbPath);
    secondTab.addGlobalLedgerBaseline(200);
    secondTab.addGlobalLedgerActual(20);
    secondTab.recordGlobalSessionStart();

    expect(secondTab.getGlobalLedgerTotals()).toEqual({ baselineTokens: 400, actualTokens: 40, sessionCount: 2 });
    secondTab.close();
    catalog = new Catalog(dbPath); // afterEach expects `catalog` to still be open+closeable
  });
});
