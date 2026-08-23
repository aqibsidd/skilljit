import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Catalog } from "@skilljit/core";
import { runSync } from "../src/commands/sync.js";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function textResponse(body: string) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body } as Response;
}

const SKILL_MD = `---
name: demo-skill
description: A demo skill used only for tests.
---
demo body`;

describe("runSync", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("ingests configured sources into the catalog db and reports counts", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-"));
    const dbPath = path.join(dir, "catalog.db");
    const fetchImpl = (async (url: string) => {
      if (url.includes("/git/trees")) {
        return jsonResponse({ truncated: false, tree: [{ path: "demo/SKILL.md", type: "blob" }] });
      }
      if (url.includes("/repos/")) return jsonResponse({ default_branch: "main" });
      return textResponse(SKILL_MD);
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const result = await runSync({
      dbPath,
      sources: [{ owner: "acme", repo: "one" }],
      fetchImpl,
      log: (s) => logs.push(s),
    });

    expect(result.total).toBe(1);
    const catalog = new Catalog(dbPath);
    expect(catalog.count()).toBe(1);
    expect(catalog.getSkill("github:acme/one/demo")?.name).toBe("demo-skill");
    catalog.close();
    expect(logs.length).toBeGreaterThan(0);
  });

  it("continues syncing remaining sources if one repo fails", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-"));
    const dbPath = path.join(dir, "catalog.db");
    const fetchImpl = (async (url: string) => {
      if (url.includes("acme/bad")) throw new Error("network down");
      if (url.includes("/git/trees")) {
        return jsonResponse({ truncated: false, tree: [{ path: "demo/SKILL.md", type: "blob" }] });
      }
      if (url.includes("/repos/")) return jsonResponse({ default_branch: "main" });
      return textResponse(SKILL_MD);
    }) as unknown as typeof fetch;

    const result = await runSync({
      dbPath,
      sources: [
        { owner: "acme", repo: "bad" },
        { owner: "acme", repo: "good" },
      ],
      fetchImpl,
      log: () => {},
    });
    expect(result.total).toBe(1);
    expect(result.failedSources).toEqual([{ owner: "acme", repo: "bad" }]);
  });
});
