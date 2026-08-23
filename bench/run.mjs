#!/usr/bin/env node
/**
 * recall@k harness for skilljit's skill_find ranking.
 *
 * Loads bench/fixtures/catalog.json into a throwaway sqlite db, runs every
 * query in bench/dataset.json through Catalog.searchSkills, and reports the
 * fraction of queries where the expected skill appears in the top 1/3/8
 * results. This is the number the README quotes — it exists so "our search
 * works" is a measured claim, not a vibe, and so switching to embeddings
 * later is a decision backed by a before/after number instead of intuition.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Catalog } from "@skilljit/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const catalogFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/catalog.json"), "utf8"));
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset.json"), "utf8"));

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-bench-")), "catalog.db");
const catalog = new Catalog(dbPath);
catalog.upsertSkills(
  catalogFixture.map((s) => ({
    ...s,
    body: s.body ?? `# ${s.name}\n\n(bench fixture, body omitted)`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
);

const K_VALUES = [1, 3, 8];
const hitsAt = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
const misses = [];

for (const { query, expectedId } of dataset) {
  const results = catalog.searchSkills(query, Math.max(...K_VALUES));
  const rankIndex = results.findIndex((r) => r.skill.id === expectedId);
  for (const k of K_VALUES) {
    if (rankIndex !== -1 && rankIndex < k) hitsAt[k] += 1;
  }
  if (rankIndex === -1 || rankIndex >= 3) {
    misses.push({ query, expectedId, gotTop3: results.slice(0, 3).map((r) => r.skill.id) });
  }
}

catalog.close();
fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });

const n = dataset.length;
console.log(`skilljit bench — ${n} queries over ${catalogFixture.length} skills\n`);
for (const k of K_VALUES) {
  const pct = ((hitsAt[k] / n) * 100).toFixed(1);
  console.log(`recall@${k}: ${hitsAt[k]}/${n}  (${pct}%)`);
}

if (misses.length > 0) {
  console.log(`\nQueries where the expected skill missed the top 3 (candidates for tuning / embeddings):`);
  for (const m of misses) {
    console.log(`  - "${m.query}" -> expected ${m.expectedId}, got [${m.gotTop3.join(", ") || "none"}]`);
  }
}
