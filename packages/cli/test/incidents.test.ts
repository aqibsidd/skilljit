import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readIncidentsConfig, writeIncidentsConfig, cmdIncidentsInit, cmdIncidentsInstallHook } from "../src/commands/incidents.js";

describe("incidents config", () => {
  let stateDir: string;
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it("returns undefined when no config file exists yet", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    expect(readIncidentsConfig(stateDir)).toBeUndefined();
  });

  it("round-trips a written config", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    writeIncidentsConfig(stateDir, { repoUrl: "git@example.com:acme/incidents.git", localClonePath: "/tmp/x" });
    expect(readIncidentsConfig(stateDir)).toEqual({
      repoUrl: "git@example.com:acme/incidents.git",
      localClonePath: "/tmp/x",
    });
  });
});

describe("cmdIncidentsInit", () => {
  let stateDir: string;
  let srcRepo: string;
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(srcRepo, { recursive: true, force: true });
  });

  it("clones the repo and writes the config", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-init-src-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: srcRepo });
    fs.writeFileSync(path.join(srcRepo, "README.md"), "# incidents");
    execFileSync("git", ["add", "-A"], { cwd: srcRepo });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
      cwd: srcRepo,
    });

    const logs: string[] = [];
    await cmdIncidentsInit({ repoUrl: srcRepo, stateDir }, (l) => logs.push(l));

    const config = readIncidentsConfig(stateDir);
    expect(config?.repoUrl).toBe(srcRepo);
    expect(fs.existsSync(path.join(config!.localClonePath, "README.md"))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("cmdIncidentsInstallHook", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is a dry run by default — prints the change but doesn't write it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

    const logs: string[] = [];
    await cmdIncidentsInstallHook({ settingsPath }, (l) => logs.push(l));

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks).toBeUndefined();
    expect(logs.join("\n")).toContain("--yes");
  });

  it("writes the hook entry when --yes is passed, preserving existing settings", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "skilljit capture-incident" }] },
    ]);
  });

  it("appends to an existing PostToolUse hook list instead of overwriting it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
    );

    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[1].matcher).toBe("Bash");
  });

  it("is idempotent — running it twice doesn't duplicate the hook entry", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2));

    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});
    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });
});

describe("looksLikeFixCommit", () => {
  it("matches conventional fix-prefixed messages", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit -m "fix: checkout timeout under load"`)).toBe(true);
    expect(looksLikeFixCommit(`git commit -m 'fixes #123'`)).toBe(true);
    expect(looksLikeFixCommit(`git commit -m "closes #45, resolved the race"`)).toBe(true);
  });

  it("does not match unrelated commits", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit -m "add new dashboard widget"`)).toBe(false);
  });

  it("does not match non-commit bash commands", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git status`)).toBe(false);
    expect(looksLikeFixCommit(`npm test`)).toBe(false);
  });

  it("does not match a git commit with no inline message", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit`)).toBe(false);
  });
});

describe("synthesizeIncident", () => {
  it("calls the injected synthesizeImpl and parses its JSON response", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const fakeSynthesize = async (_prompt: string) =>
      JSON.stringify({
        symptom: "Checkout timed out",
        investigation: "Ruled out payments",
        rootCause: "Lock contention",
        fix: "Reran migration concurrently",
      });

    const result = await synthesizeIncident("transcript text", "diff text", fakeSynthesize);
    expect(result.symptom).toBe("Checkout timed out");
    expect(result.fix).toBe("Reran migration concurrently");
  });

  it("throws a clear error if the response isn't valid JSON with the expected fields", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const fakeSynthesize = async () => "not json";
    await expect(synthesizeIncident("t", "d", fakeSynthesize)).rejects.toThrow(/synthes/i);
  });
});
