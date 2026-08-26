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

  it("gives a brand-new empty incidents repo a first commit so captures have somewhere to push", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-empty-"));
    const { execFileSync } = await import("node:child_process");
    // A bare repo with no commits at all — what `gh repo create` (no
    // README) hands you. A plain clone of this has no HEAD and no
    // upstream tracking branch, so the first capture's pull/push both
    // fail unless init establishes one.
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", srcRepo]);

    await cmdIncidentsInit({ repoUrl: srcRepo, stateDir }, () => {});

    const config = readIncidentsConfig(stateDir)!;
    // The clone has a commit ...
    const localSha = execFileSync("git", ["-C", config.localClonePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(localSha).toMatch(/^[0-9a-f]{40}$/);
    // ... it was pushed to the remote ...
    const remoteSha = execFileSync("git", ["-C", srcRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(remoteSha).toBe(localSha);
    // ... and the local branch tracks the remote one, so `git pull` and
    // `git push` with no arguments both work from here on.
    const upstream = execFileSync(
      "git",
      ["-C", config.localClonePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { encoding: "utf8" },
    ).trim();
    expect(upstream).toMatch(/^origin\//);
  });

  it("refuses to re-point an existing clone at a different repo URL", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-init-src-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", srcRepo]);
    await cmdIncidentsInit({ repoUrl: srcRepo, stateDir }, () => {});

    // Re-running against a *different* URL used to pull the old remote and
    // then write the new URL into incidents.json — capture would push to
    // the old repo while sync read the new one, with no error anywhere.
    await expect(
      cmdIncidentsInit({ repoUrl: "git@example.com:other/incidents.git", stateDir }, () => {}),
    ).rejects.toThrow(/already/i);

    // The recorded config still points at the original repo, not the new one.
    expect(readIncidentsConfig(stateDir)?.repoUrl).toBe(srcRepo);
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
      { matcher: "Bash", hooks: [{ type: "command", command: "skilljit capture-incident", timeout: 600 }] },
    ]);
  });

  it("sets an explicit generous timeout — the hook does an inline claude -p call", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2));

    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // Claude Code's default hook timeout is 60s; a real synthesis call
    // routinely exceeds that and would stall the session on every fix commit.
    expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBeGreaterThanOrEqual(300);
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

  it("matches `resolves #`", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit -m "resolves #77 by retrying the fetch"`)).toBe(true);
  });

  it("matches Claude Code's own heredoc commit shape", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    // This is the exact form Claude Code uses for every commit it makes.
    // The extracted -m argument is `$(cat <<'EOF' ... )`, so an anchored,
    // non-multiline ^fix: never matched it — meaning the hook essentially
    // never fired for the tool it ships with.
    const command = `git commit -m "$(cat <<'EOF'
fix: retry the flaky upload on 502

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"`;
    expect(looksLikeFixCommit(command)).toBe(true);
  });

  it("does not match a non-fix heredoc commit", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    const command = `git commit -m "$(cat <<'EOF'
feat: add a dashboard widget

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"`;
    expect(looksLikeFixCommit(command)).toBe(false);
  });

  it("matches combined short flags like -am", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit -am "fix: drop the stale cache entry"`)).toBe(true);
  });
});

describe("extractCommitMessage", () => {
  it("unwraps a heredoc-wrapped message down to the real commit text", async () => {
    const { extractCommitMessage } = await import("../src/commands/incidents.js");
    const command = `git commit -m "$(cat <<'EOF'
fix: retry the flaky upload on 502

Body line.
EOF
)"`;
    expect(extractCommitMessage(command)).toBe("fix: retry the flaky upload on 502\n\nBody line.");
  });

  it("returns a plain inline message unchanged, and undefined for a non-commit", async () => {
    const { extractCommitMessage } = await import("../src/commands/incidents.js");
    expect(extractCommitMessage(`git commit -m "fix: a thing"`)).toBe("fix: a thing");
    expect(extractCommitMessage(`npm test`)).toBeUndefined();
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

  // `claude -p --output-format json` does NOT return the model's answer
  // directly — it returns a *result envelope* whose `result` field holds the
  // answer as a string. Every test on this branch injected a fake
  // synthesizeImpl returning the bare answer, so the real production shape
  // was never exercised and every real call failed with "missing required
  // fields". The fixtures below are trimmed from real `claude -p
  // --output-format json` output.
  const ANSWER = {
    symptom: "Checkout timed out under load.",
    investigation: "Ruled out the payment provider.",
    rootCause: "A migration held a lock on a hot table.",
    fix: "Reran with CREATE INDEX CONCURRENTLY.",
  };
  function envelope(result: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      is_error: false,
      duration_api_ms: 2934,
      num_turns: 1,
      stop_reason: "end_turn",
      session_id: "ec66b307-43c1-4bfa-a560-26908a36cda0",
      total_cost_usd: 0.085209,
      usage: { input_tokens: 2, output_tokens: 44 },
      permission_denials: [],
      subtype: "success",
      api_error_status: null,
      result,
      type: "result",
      duration_ms: 3262,
      ...overrides,
    });
  }

  it("unwraps the `claude -p --output-format json` result envelope", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const result = await synthesizeIncident("t", "d", async () => envelope(JSON.stringify(ANSWER)));
    expect(result).toEqual(ANSWER);
  });

  it("unwraps an envelope whose result is wrapped in a ```json fence", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const fenced = "```json\n" + JSON.stringify(ANSWER, null, 2) + "\n```";
    const result = await synthesizeIncident("t", "d", async () => envelope(fenced));
    expect(result).toEqual(ANSWER);
  });

  it("tolerates the model prefacing the JSON object with prose", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const chatty = `Here's the summary you asked for:\n\n${JSON.stringify(ANSWER)}`;
    const result = await synthesizeIncident("t", "d", async () => envelope(chatty));
    expect(result).toEqual(ANSWER);
  });

  it("surfaces a `claude -p` error envelope as a clear error", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const errEnvelope = envelope("Credit balance is too low", { is_error: true, subtype: "error_during_execution" });
    await expect(synthesizeIncident("t", "d", async () => errEnvelope)).rejects.toThrow(/claude -p/i);
  });

  it("windows a multi-megabyte transcript and caps the diff before building the prompt", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    // Real Claude Code transcripts run 1.8–13MB. Passing one through
    // untouched is both an ARG_MAX/cost problem and pointless — the tail is
    // where the fix actually happened.
    const transcript = Array.from({ length: 60_000 }, (_, i) => `{"turn":${i},"text":"padding padding"}`).join("\n");
    const diff = "diff --git a/a.ts b/a.ts\n" + "+".repeat(500_000);
    let seenPrompt = "";
    await synthesizeIncident(transcript, diff, async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify(ANSWER);
    });

    expect(seenPrompt.length).toBeLessThan(200_000);
    // The *end* of the transcript survives — that's the part describing the fix.
    expect(seenPrompt).toContain(`{"turn":59999,"text":"padding padding"}`);
    expect(seenPrompt).not.toContain(`{"turn":0,`);
    expect(seenPrompt).toMatch(/truncated/i);
  });

  it("passes short transcripts and diffs through untouched", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    let seenPrompt = "";
    await synthesizeIncident("the whole transcript", "the whole diff", async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify(ANSWER);
    });
    expect(seenPrompt).toContain("the whole transcript");
    expect(seenPrompt).toContain("the whole diff");
    expect(seenPrompt).not.toMatch(/truncated/i);
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
    execFileSync("git", ["remote", "add", "origin", "git@example.com:acme/webapp.git"], { cwd: codeRepo });
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
    expect(content).toContain("acme/webapp.git");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(codeRepo, { recursive: true, force: true });
  });

  it("attributes the incident commit to the developer's own git identity when the code repo has one configured", async () => {
    const { execFileSync } = await import("node:child_process");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    localClonePath = path.join(stateDir, "incidents-write");
    execFileSync("git", ["clone", "-q", remote, localClonePath]);
    execFileSync("sh", ["-c", `cd '${localClonePath}' && git -c user.email=t@t.com -c user.name=t commit --allow-empty -q -m init`]);
    execFileSync("git", ["push", "-q"], { cwd: localClonePath });

    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: remote, localClonePath });

    const codeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-code-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: codeRepo });
    execFileSync("git", ["remote", "add", "origin", "git@example.com:acme/webapp.git"], { cwd: codeRepo });
    // Persistent repo config this time (not a command-scoped -c override) —
    // this is what a real developer's checkout actually has.
    execFileSync("git", ["config", "user.name", "Jane Dev"], { cwd: codeRepo });
    execFileSync("git", ["config", "user.email", "jane@example.com"], { cwd: codeRepo });
    fs.writeFileSync(path.join(codeRepo, "app.ts"), "// fixed\n");
    execFileSync("git", ["add", "-A"], { cwd: codeRepo });
    execFileSync("git", ["commit", "-q", "-m", "fix: checkout timeout"], { cwd: codeRepo });

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
    const author = execFileSync("git", ["-C", localClonePath, "log", "-1", "--format=%an|%ae"], { encoding: "utf8" }).trim();
    expect(author).toBe("Jane Dev|jane@example.com");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(codeRepo, { recursive: true, force: true });
  });

  it("falls back to the skilljit identity when the code repo has none configured", async () => {
    const { execFileSync, execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    // GIT_CONFIG_GLOBAL/SYSTEM=/dev/null isolates this from whatever git
    // identity happens to be configured on the machine actually running
    // this test — without it, a developer's own global user.name/email
    // would leak in and this "no identity configured" scenario could
    // never be reproduced on a machine that has one set (i.e. most of
    // them, including the one this was written on).
    const isolatedExecFile = (cmd: string, args: string[]) =>
      execFileAsync(cmd, args, {
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    localClonePath = path.join(stateDir, "incidents-write");
    execFileSync("git", ["clone", "-q", remote, localClonePath]);
    execFileSync("sh", ["-c", `cd '${localClonePath}' && git -c user.email=t@t.com -c user.name=t commit --allow-empty -q -m init`]);
    execFileSync("git", ["push", "-q"], { cwd: localClonePath });

    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: remote, localClonePath });

    const codeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-code-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: codeRepo });
    execFileSync("git", ["remote", "add", "origin", "git@example.com:acme/webapp.git"], { cwd: codeRepo });
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
      execFileImpl: isolatedExecFile,
    });

    expect(result.captured).toBe(true);
    const author = execFileSync("git", ["-C", localClonePath, "log", "-1", "--format=%an|%ae"], { encoding: "utf8" }).trim();
    expect(author).toBe("skilljit|skilljit@localhost");

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
    execFileSync("git", ["remote", "add", "origin", "git@example.com:acme/webapp.git"], { cwd: srcRepo });
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

  it("fails closed rather than throwing when incidents.json is malformed", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    // Write garbage directly, bypassing writeIncidentsConfig, so
    // fs.existsSync sees a file but JSON.parse inside readIncidentsConfig
    // throws — this is exactly the gap the fail-closed try/catch needs to
    // cover: existsSync only proves the file exists, not that it parses.
    fs.writeFileSync(path.join(stateDir, "incidents.json"), "{ this is not valid json");

    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(makePayload(), { stateDir });

    expect(result.captured).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("redacts secrets out of the failure reason itself when synthesis leaks unredacted text", async () => {
    const { execFileSync } = await import("node:child_process");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    localClonePath = path.join(stateDir, "incidents-write");
    fs.mkdirSync(localClonePath, { recursive: true });
    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: "unused", localClonePath });

    // Real git repo as cwd, same as the other fail-closed test, so the
    // pipeline reaches synthesizeIncident rather than failing earlier.
    const srcRepo = path.join(stateDir, "src-repo");
    fs.mkdirSync(srcRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: srcRepo });
    execFileSync("git", ["remote", "add", "origin", "git@example.com:acme/webapp.git"], { cwd: srcRepo });
    fs.writeFileSync(path.join(srcRepo, "app.ts"), "// fixed\n");
    execFileSync("git", ["add", "-A"], { cwd: srcRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "fix: checkout timeout"],
      { cwd: srcRepo },
    );

    const transcriptPath = path.join(stateDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "x");

    // Not valid JSON, so synthesizeIncident's catch throws an error whose
    // message embeds up to 200 raw characters of this response — content
    // that hasn't been through redactSecrets yet, since that failure
    // happens before the redaction step ever runs. The secret below
    // matches redactSecrets's AWS-key pattern.
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const fakeSynthesize = async () => `not json but leaks ${secret}`;

    const result = await runCaptureIncident(makePayload({ transcript_path: transcriptPath, cwd: srcRepo }), {
      stateDir,
      synthesizeImpl: fakeSynthesize,
    });

    expect(result.captured).toBe(false);
    expect(result.reason).not.toContain(secret);
  });

  it("skips capture when the actual last commit doesn't match what the command claimed", async () => {
    const { execFileSync } = await import("node:child_process");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    localClonePath = path.join(stateDir, "incidents-write");
    fs.mkdirSync(localClonePath, { recursive: true });
    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: "unused", localClonePath });

    const srcRepo = path.join(stateDir, "src-repo");
    fs.mkdirSync(srcRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: srcRepo });
    execFileSync("git", ["remote", "add", "origin", "git@example.com:acme/webapp.git"], { cwd: srcRepo });
    fs.writeFileSync(path.join(srcRepo, "app.ts"), "// unrelated\n");
    execFileSync("git", ["add", "-A"], { cwd: srcRepo });
    // The commit that actually landed has a different message than the
    // Bash command claims — e.g. a pre-commit hook rewrote it, or the
    // hook fired against a stale HEAD after a rejected commit.
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "chore: unrelated housekeeping"],
      { cwd: srcRepo },
    );

    let synthesizeCalled = false;
    const result = await runCaptureIncident(makePayload({ cwd: srcRepo }), {
      stateDir,
      synthesizeImpl: async () => {
        synthesizeCalled = true;
        return "{}";
      },
    });

    expect(result.captured).toBe(false);
    expect(synthesizeCalled).toBe(false);
  });
});
