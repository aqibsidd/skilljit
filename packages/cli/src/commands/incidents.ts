import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileFn } from "@skilljit/core";
import { redactSecrets, serializeIncidentMd } from "@skilljit/core";

const execFileAsync = promisify(execFile);

export interface IncidentsConfig {
  repoUrl: string;
  localClonePath: string;
}

function configPath(stateDir: string): string {
  return path.join(stateDir, "incidents.json");
}

export function readIncidentsConfig(stateDir: string): IncidentsConfig | undefined {
  const file = configPath(stateDir);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as IncidentsConfig;
}

export function writeIncidentsConfig(stateDir: string, config: IncidentsConfig): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath(stateDir), JSON.stringify(config, null, 2));
}

export interface IncidentsInitOptions {
  repoUrl: string;
  stateDir: string;
  execFileImpl?: ExecFileFn;
}

/**
 * One-time setup: clones the incidents repo into a persistent local
 * working copy (distinct from the ephemeral bare-mirror worktrees sync
 * uses for reading) and records its location, so capture-incident has
 * somewhere durable to commit+push into.
 */
export async function cmdIncidentsInit(opts: IncidentsInitOptions, log: (s: string) => void): Promise<void> {
  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const localClonePath = path.join(opts.stateDir, "incidents-write");

  if (fs.existsSync(localClonePath)) {
    log(`Updating existing local clone at ${localClonePath} ...`);
    await run("git", ["-C", localClonePath, "pull", "--quiet"]);
  } else {
    log(`Cloning ${opts.repoUrl} to ${localClonePath} ...`);
    fs.mkdirSync(opts.stateDir, { recursive: true });
    await run("git", ["clone", "--quiet", opts.repoUrl, localClonePath]);
  }

  writeIncidentsConfig(opts.stateDir, { repoUrl: opts.repoUrl, localClonePath });
  log(`Incidents repo configured: ${opts.repoUrl}`);
  log(`Run \`skilljit incidents install-hook\` next to capture incidents automatically.`);
}

const CAPTURE_HOOK_ENTRY = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "skilljit capture-incident" }],
};

export interface IncidentsInstallHookOptions {
  settingsPath: string;
  yes?: boolean;
}

/**
 * Proposes (or, with --yes, writes) the PostToolUse hook entry that
 * triggers incident capture on fix-like git commits. Mirrors cmdAdopt's
 * dry-run-first posture — never edits a settings file the user relies on
 * without explicit confirmation.
 */
export async function cmdIncidentsInstallHook(opts: IncidentsInstallHookOptions, log: (s: string) => void): Promise<void> {
  const settings = fs.existsSync(opts.settingsPath)
    ? (JSON.parse(fs.readFileSync(opts.settingsPath, "utf8")) as Record<string, any>)
    : {};

  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  const alreadyInstalled = settings.hooks.PostToolUse.some(
    (entry: any) => entry.matcher === "Bash" && entry.hooks?.some((h: any) => h.command === "skilljit capture-incident"),
  );

  if (alreadyInstalled) {
    log(`Hook already installed in ${opts.settingsPath}.`);
    return;
  }

  if (!opts.yes) {
    log(`This will add a PostToolUse hook to ${opts.settingsPath}:`);
    log(JSON.stringify(CAPTURE_HOOK_ENTRY, null, 2));
    log(`Re-run with --yes to write it.`);
    return;
  }

  settings.hooks.PostToolUse.push(CAPTURE_HOOK_ENTRY);
  fs.writeFileSync(opts.settingsPath, JSON.stringify(settings, null, 2));
  log(`Hook installed in ${opts.settingsPath}.`);
}

const FIX_MESSAGE_RE = /^(fix|fixes|fixed)[:(]|fixes #|closes #|resolves #/i;
const INLINE_MESSAGE_RE = /-m\s+"([^"]*)"|-m\s+'([^']*)'/;

/** Extracts a `git commit -m "..."` message and checks it against a
 * fix-commit heuristic. A `git commit` with no inline -m (opens $EDITOR)
 * is intentionally not matched — this is a v1 scope limit, not a bug. */
export function looksLikeFixCommit(bashCommand: string): boolean {
  if (!/\bgit\s+commit\b/.test(bashCommand)) return false;
  const messageMatch = INLINE_MESSAGE_RE.exec(bashCommand);
  if (!messageMatch) return false;
  const message = messageMatch[1] ?? messageMatch[2] ?? "";
  return FIX_MESSAGE_RE.test(message);
}

export interface SynthesizedIncident {
  symptom: string;
  investigation: string;
  rootCause: string;
  fix: string;
}

function defaultSynthesizeImpl(prompt: string): Promise<string> {
  // Reuses the execFileAsync already defined at module scope in Task 7 —
  // no second promisify(execFile) needed.
  return execFileAsync("claude", ["-p", prompt, "--output-format", "json"]).then((r) => r.stdout);
}

/**
 * Synthesizes the four narrative incident fields from a session
 * transcript and a commit diff. Shells out to `claude -p` by default
 * (Claude Code's own non-interactive mode — already installed and
 * authenticated wherever the capture hook runs), injectable for tests.
 */
export async function synthesizeIncident(
  transcript: string,
  diff: string,
  synthesizeImpl: (prompt: string) => Promise<string> = defaultSynthesizeImpl,
): Promise<SynthesizedIncident> {
  const prompt =
    "You are summarizing a debugging session that just ended in a bug fix, for a teammate " +
    "who might hit the same problem later. From the transcript and diff below, respond with " +
    'ONLY a JSON object: {"symptom": "...", "investigation": "...", "rootCause": "...", "fix": "..."}. ' +
    "Paraphrase — never quote raw error output, log lines, or literal values verbatim; use " +
    "placeholders for anything that looks like a value rather than a pattern.\n\n" +
    `TRANSCRIPT:\n${transcript}\n\nDIFF:\n${diff}`;

  const raw = await synthesizeImpl(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`synthesizeIncident: response was not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as any).symptom !== "string" ||
    typeof (parsed as any).investigation !== "string" ||
    typeof (parsed as any).rootCause !== "string" ||
    typeof (parsed as any).fix !== "string"
  ) {
    throw new Error(`synthesizeIncident: response was missing required fields: ${raw.slice(0, 200)}`);
  }
  return parsed as SynthesizedIncident;
}

export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: { command?: string };
}

export interface CaptureIncidentOptions {
  stateDir: string;
  execFileImpl?: ExecFileFn;
  readFileImpl?: (filePath: string) => string;
  synthesizeImpl?: (prompt: string) => Promise<string>;
}

/**
 * The full capture pipeline, invoked by the installed PostToolUse hook.
 * Every early-exit path returns {captured: false, reason} rather than
 * throwing — a hook failing loudly would be disruptive mid-session for
 * something that's supposed to be invisible on the common case (an
 * ordinary commit that isn't a fix).
 */
export async function runCaptureIncident(
  payload: HookPayload,
  opts: CaptureIncidentOptions,
): Promise<{ captured: boolean; reason: string }> {
  if (payload.tool_name !== "Bash") {
    return { captured: false, reason: "not a Bash tool call" };
  }
  const command = payload.tool_input.command ?? "";
  if (!looksLikeFixCommit(command)) {
    return { captured: false, reason: "commit does not look like a fix" };
  }

  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const readFile = opts.readFileImpl ?? ((p: string) => fs.readFileSync(p, "utf8"));

  // Everything below can fail in ways outside our control (a corrupted
  // config file, a missing transcript file, a git command failing, a
  // malformed synthesis response) — all of it is wrapped in one
  // try/catch so any such failure fails closed (returns
  // {captured: false}) rather than throwing out of a PostToolUse hook
  // mid-session. The only "success" path writes anything to disk, and
  // only after allClean is confirmed. readIncidentsConfig is included
  // here (not read before the try) because its JSON.parse can throw on
  // a malformed incidents.json — fs.existsSync only proves the file is
  // there, not that its contents parse.
  try {
    const config = readIncidentsConfig(opts.stateDir);
    if (!config) {
      return { captured: false, reason: "incidents not configured (run: skilljit incidents init <repo-url>)" };
    }

    const { stdout: shaOut } = await run("git", ["-C", payload.cwd, "rev-parse", "HEAD"]);
    const commitSha = shaOut.trim();
    const { stdout: diff } = await run("git", ["-C", payload.cwd, "show", commitSha]);
    const transcript = readFile(payload.transcript_path);

    const synthesized = await synthesizeIncident(transcript, diff, opts.synthesizeImpl);

    const redactedFields = {
      symptom: redactSecrets(synthesized.symptom),
      investigation: redactSecrets(synthesized.investigation),
      rootCause: redactSecrets(synthesized.rootCause),
      fix: redactSecrets(synthesized.fix),
    };
    const allClean = Object.values(redactedFields).every((r) => r.clean);
    if (!allClean) {
      return { captured: false, reason: "redaction failed, needs manual review" };
    }

    const capturedAt = new Date().toISOString();
    const record = {
      symptom: redactedFields.symptom.text,
      investigation: redactedFields.investigation.text,
      rootCause: redactedFields.rootCause.text,
      fix: redactedFields.fix.text,
      commitSha,
      repo: `git:${config.repoUrl}`,
      capturedAt,
      verified: false,
    };

    await run("git", ["-C", config.localClonePath, "pull", "--quiet"]);
    const incidentsDir = path.join(config.localClonePath, "incidents");
    fs.mkdirSync(incidentsDir, { recursive: true });
    const filename = `${capturedAt.slice(0, 10)}-${commitSha.slice(0, 7)}.md`;
    fs.writeFileSync(path.join(incidentsDir, filename), serializeIncidentMd(record));

    await run("git", ["-C", config.localClonePath, "add", `incidents/${filename}`]);
    await run("git", [
      "-C",
      config.localClonePath,
      "-c",
      "user.email=skilljit@localhost",
      "-c",
      "user.name=skilljit",
      "commit",
      "-q",
      "-m",
      `incident: ${record.symptom.slice(0, 60)}`,
    ]);
    await run("git", ["-C", config.localClonePath, "push", "--quiet"]);

    return { captured: true, reason: "incident captured and pushed" };
  } catch (err) {
    // The error message can itself carry unredacted content — e.g.
    // synthesizeIncident's shape-check error embeds up to 200 raw
    // characters of the model's response, which hasn't been through
    // redactSecrets yet at that point in the pipeline (that failure
    // happens *before* redaction runs). Run the reason through the same
    // redaction pass before it's ever returned or logged, rather than
    // exposing the raw message.
    const rawReason = `incident capture failed: ${(err as Error).message}`;
    const redactedReason = redactSecrets(rawReason);
    return {
      captured: false,
      reason: redactedReason.clean ? redactedReason.text : "incident capture failed (details withheld, needs manual review)",
    };
  }
}
