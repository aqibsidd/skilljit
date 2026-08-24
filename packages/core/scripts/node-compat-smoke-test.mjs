#!/usr/bin/env node
/**
 * Runtime compatibility check for @skilljit/core, run directly with `node`
 * (not vitest — vitest itself requires Node >=20, so it can't verify the
 * Node 16/18 floor this package actually claims). Exercises the two things
 * that are genuinely Node-version-sensitive:
 *   1. better-sqlite3's native binding (no prebuild exists for Node 16 on
 *      any platform, so this either loads a prebuilt binary or confirms a
 *      node-gyp source compile succeeded).
 *   2. ingestGithubRepo's fetch path, via an injected fetchImpl so this
 *      doesn't depend on live network/GitHub rate limits in CI. The global
 *      fetch vs. node-fetch fallback selection itself was verified by hand
 *      against a real Node 16 install and a live GitHub repo — see the
 *      Node version support section in the root README.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Catalog, ingestGithubRepo } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
console.log(`Node ${process.version} — global fetch available: ${typeof globalThis.fetch === "function"}`);

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-smoke-")), "catalog.db");
const catalog = new Catalog(dbPath);
catalog.upsertSkills([
  {
    id: "acme/repo/pdf-processing",
    name: "pdf-processing",
    source: "github:acme/repo",
    description: "Extract text and tables from PDF files.",
    body: "# PDF processing\n\nUse pdfplumber.",
    updatedAt: new Date().toISOString(),
  },
]);
const hits = catalog.searchSkills("pdf extraction", 5);
assert.equal(hits.length, 1, "FTS5 search should find the seeded skill");
assert.equal(hits[0].skill.name, "pdf-processing");
catalog.close();
console.log("PASS: better-sqlite3 native binding + FTS5 search");

const SKILL_MD = "---\nname: demo-skill\ndescription: A demo skill for the Node compat smoke test.\n---\nbody";
let fetchCalls = 0;
const fakeFetch = async (url) => {
  fetchCalls++;
  if (String(url).includes("/git/trees")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ truncated: false, tree: [{ path: "demo/SKILL.md", type: "blob" }] }),
      text: async () => "",
    };
  }
  if (String(url).includes("/repos/")) {
    return { ok: true, status: 200, json: async () => ({ default_branch: "main" }), text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => SKILL_MD };
};
const skills = await ingestGithubRepo("acme", "repo", { fetchImpl: fakeFetch });
assert.equal(skills.length, 1, "ingestGithubRepo should parse the mocked skill");
assert.equal(skills[0].name, "demo-skill");
assert.ok(fetchCalls > 0, "fetchImpl should have been invoked");
console.log("PASS: ingestGithubRepo with an injected fetchImpl");

console.log(`\nAll Node compatibility smoke tests passed on ${process.version} (ran from ${__dirname})`);
