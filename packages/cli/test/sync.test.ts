import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Catalog } from "@skilljit/core";
import { runSync } from "../src/commands/sync.js";
import { writeIncidentsConfig } from "../src/commands/incidents.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

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

  it("passes token through to raw content fetches for --repo sources", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-"));
    const dbPath = path.join(dir, "catalog.db");
    const seenAuth: (string | undefined)[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/git/trees")) {
        return jsonResponse({ truncated: false, tree: [{ path: "demo/SKILL.md", type: "blob" }] });
      }
      if (url.includes("/repos/")) return jsonResponse({ default_branch: "main" });
      seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return textResponse(SKILL_MD);
    }) as unknown as typeof fetch;

    await runSync({
      dbPath,
      sources: [{ owner: "acme", repo: "one" }],
      token: "secret-token",
      fetchImpl,
      log: () => {},
    });
    expect(seenAuth).toEqual(["Bearer secret-token"]);
  });

  it("ingests skills from a git worktree source alongside GitHub sources", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-"));
    const dbPath = path.join(dir, "catalog.db");
    const srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-git-src-"));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-git-cache-"));
    try {
      git(srcRepo, ["init", "-q", "-b", "main"]);
      fs.mkdirSync(path.join(srcRepo, "internal-skill"));
      fs.writeFileSync(
        path.join(srcRepo, "internal-skill", "SKILL.md"),
        "---\nname: internal-skill\ndescription: An internal Ambak skill.\n---\nbody",
      );
      git(srcRepo, ["add", "-A"]);
      git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add skill"]);

      const result = await runSync({
        dbPath,
        sources: [],
        gitSources: [srcRepo],
        gitCacheDir: cacheDir,
        log: () => {},
      });

      expect(result.total).toBe(1);
      expect(result.perGitSource).toEqual([{ url: srcRepo, count: 1 }]);
      const catalog = new Catalog(dbPath);
      expect(catalog.getSkill(`git:${srcRepo}/internal-skill`)?.name).toBe("internal-skill");
      catalog.close();
    } finally {
      fs.rmSync(srcRepo, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("also ingests a configured incidents repo, into the same catalog", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-"));
    const dbPath = path.join(dir, "catalog.db");
    const stateDir = path.join(dir, "state");

    const { execFileSync } = await import("node:child_process");
    const incidentsRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-incidents-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: incidentsRepo });
    fs.mkdirSync(path.join(incidentsRepo, "incidents"));
    const { serializeIncidentMd } = await import("@skilljit/core");
    fs.writeFileSync(
      path.join(incidentsRepo, "incidents", "2026-08-24-a1b2c3d.md"),
      serializeIncidentMd({
        symptom: "Checkout timed out.",
        investigation: "x",
        rootCause: "y",
        fix: "z",
        commitSha: "a1b2c3d4",
        repo: `git:${incidentsRepo}`,
        capturedAt: "2026-08-24T00:00:00.000Z",
        verified: false,
      }),
    );
    execFileSync("git", ["add", "-A"], { cwd: incidentsRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add incident"],
      { cwd: incidentsRepo },
    );
    writeIncidentsConfig(stateDir, { repoUrl: incidentsRepo, localClonePath: incidentsRepo });

    const result = await runSync({ dbPath, sources: [], stateDir, log: () => {} });
    expect(result.incidentsIngested).toBe(1);

    const { Catalog } = await import("@skilljit/core");
    const catalog = new Catalog(dbPath);
    expect(catalog.incidentCount()).toBe(1);
    catalog.close();

    fs.rmSync(incidentsRepo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
