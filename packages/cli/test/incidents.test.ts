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

describe("runCaptureIncident", () => {
  let stateDir: string | undefined;
  let localClonePath: string;
  afterEach(() => {
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  });

  function makePayload(overrides: Partial<any> = {}) {
    return {
      session_id: "s1",
      transcript_path: "/tmp/does-not-need-to-exist-for-non-matching-tests.jsonl",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: `git commit -m "fix: checkout timeout"` },
      ...overrides,
    };
  }

  it("skips non-Bash tool calls", async () => {
    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(makePayload({ tool_name: "Write" }), { stateDir: "/unused" });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/not a bash/i);
  });

  it("skips commands that aren't fix-like git commits", async () => {
    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(
      makePayload({ tool_input: { command: "npm test" } }),
      { stateDir: "/unused" },
    );
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/fix/i);
  });

  it("skips when incidents aren't configured", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(makePayload(), { stateDir });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("captures, redacts, writes, commits, and pushes on a matching fix commit", async () => {
    const { execFileSync } = await import("node:child_process");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));

    // A bare remote to push to, and a persistent local clone (as
    // cmdIncidentsInit would create) pointed at it.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    localClonePath = path.join(stateDir, "incidents-write");
    execFileSync("git", ["clone", "-q", remote, localClonePath]);
    execFileSync("sh", ["-c", `cd '${localClonePath}' && git -c user.email=t@t.com -c user.name=t commit --allow-empty -q -m init`]);
    execFileSync("git", ["push", "-q"], { cwd: localClonePath });

    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: remote, localClonePath });

    // A source repo standing in for the codebase the fix was committed to.
    const codeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-code-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: codeRepo });
    fs.writeFileSync(path.join(codeRepo, "app.ts"), "// fixed\n");
    execFileSync("git", ["add", "-A"], { cwd: codeRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "fix: checkout timeout"],
      { cwd: codeRepo },
    );

    const transcriptPath = path.join(stateDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: "user", content: "checkout was timing out" }));

    const fakeSynthesize = async () =>
      JSON.stringify({
        symptom: "Checkout timed out under load.",
        investigation: "Ruled out the payment provider.",
        rootCause: "A migration held a lock on a hot table.",
        fix: "Reran with CREATE INDEX CONCURRENTLY.",
      });

    const result = await runCaptureIncident(makePayload({ cwd: codeRepo, transcript_path: transcriptPath }), {
      stateDir,
      synthesizeImpl: fakeSynthesize,
    });

    expect(result.captured).toBe(true);
    const files = fs.readdirSync(path.join(localClonePath, "incidents"));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(localClonePath, "incidents", files[0]), "utf8");
    expect(content).toContain("Checkout timed out under load");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(codeRepo, { recursive: true, force: true });
  });

  it("fails closed and writes nothing when the synthesized response has the wrong shape", async () => {
    const { execFileSync } = await import("node:child_process");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    localClonePath = path.join(stateDir, "incidents-write");
    fs.mkdirSync(localClonePath, { recursive: true });
    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: "unused", localClonePath });

    // A real git repo with a real commit as `cwd`, so the pipeline gets
    // past `git rev-parse`/`git show` and actually reaches
    // synthesizeIncident — otherwise this would exercise the earlier
    // git-failure fail-closed path instead of the one this test is named
    // for and documents below.
    const srcRepo = path.join(stateDir, "src-repo");
    fs.mkdirSync(srcRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: srcRepo });
    fs.writeFileSync(path.join(srcRepo, "app.ts"), "// fixed\n");
    execFileSync("git", ["add", "-A"], { cwd: srcRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "fix: checkout timeout"],
      { cwd: srcRepo },
    );

    const transcriptPath = path.join(stateDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "x");

    // This exercises the synthesizeIncident shape-check fail-closed path
    // (Task 9), not redactSecrets's own fail-closed path — redactSecrets
    // catches internally and can't be made to throw through a realistic
    // string input, so its fail-closed behavior is unit-tested directly
    // in Task 2's redact.test.ts instead. Both are real fail-closed exits
    // from the same pipeline; this test covers the reachable one.
    const fakeSynthesize = async () => JSON.stringify({ symptom: 1, investigation: 2, rootCause: 3, fix: 4 });

    const result = await runCaptureIncident(makePayload({ transcript_path: transcriptPath, cwd: srcRepo }), {
      stateDir,
      synthesizeImpl: fakeSynthesize,
    });

    expect(result.captured).toBe(false);
    expect(fs.existsSync(path.join(localClonePath, "incidents"))).toBe(false);
  });
});
