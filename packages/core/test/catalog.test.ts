import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});
