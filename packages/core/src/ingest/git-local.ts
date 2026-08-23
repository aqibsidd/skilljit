import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseSkillMd } from "./parse.js";
import { isProbablyBinaryPath } from "./files.js";
import type { SkillRecord } from "../types.js";

const execFileAsync = promisify(execFile);

const IGNORED_DIR_NAMES = new Set([".git", "node_modules", ".venv", "__pycache__", "dist"]);

export interface ExecFileFn {
  (command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface LocalGitIngestOptions {
  /** Where bare mirror clones are cached between syncs. Defaults to
   * ~/.skilljit/git-cache. */
  cacheDir?: string;
  /** Branch/tag/commit to check out. Defaults to the remote's HEAD. */
  ref?: string;
  /** Injectable for tests; defaults to shelling out to the real `git`. */
  execFileImpl?: ExecFileFn;
}

function cacheKeyForUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function walkSkillDirs(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      walkSkillDirs(root, path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(path.relative(root, dir));
    }
  }
}

/**
 * Ingest every SKILL.md in an arbitrary git repository — self-hosted,
 * GitLab, Bitbucket, an internal server, or a private GitHub repo reached
 * over SSH — anywhere the `git` binary on this machine can already
 * authenticate (SSH key, git-credential helper), no GitHub API token
 * needed at all.
 *
 * Uses a persistent bare mirror clone under `cacheDir` plus a throwaway
 * `git worktree add` per sync, instead of a fresh clone every time: the
 * first sync pays for a full clone, every sync after that is just a
 * `git fetch` (cheap, incremental) followed by a worktree checkout. The
 * worktree is removed again once ingestion finishes.
 */
export async function ingestLocalGitRepo(
  url: string,
  opts: LocalGitIngestOptions = {},
): Promise<SkillRecord[]> {
  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".skilljit", "git-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bareDir = path.join(cacheDir, `${cacheKeyForUrl(url)}.git`);
  const source = `git:${url}`;

  if (!fs.existsSync(bareDir)) {
    // --mirror, not --bare: a plain --bare clone doesn't set up a fetch
    // refspec that updates local branch refs (and HEAD's target) on a
    // later `git fetch` — only --mirror does, which is what makes the
    // "clone once, fetch cheaply after" reuse actually pick up new commits.
    await run("git", ["clone", "--mirror", "--quiet", url, bareDir]);
  } else {
    await run("git", ["--git-dir", bareDir, "fetch", "--quiet", "--prune", "origin"]);
  }

  const checkoutRef = opts.ref ?? "HEAD";
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-wt-"));
  // A worktree can't be added at a path that already exists as an empty
  // dir in some git versions; remove it and let `worktree add` create it.
  fs.rmdirSync(worktreeDir);

  try {
    await run("git", ["--git-dir", bareDir, "worktree", "add", "--detach", "--quiet", worktreeDir, checkoutRef]);

    const skillDirs: string[] = [];
    walkSkillDirs(worktreeDir, worktreeDir, skillDirs);

    const results: SkillRecord[] = [];
    for (const relDir of skillDirs) {
      const absDir = path.join(worktreeDir, relDir);
      const skillMdPath = path.join(absDir, "SKILL.md");
      const content = fs.readFileSync(skillMdPath, "utf8");
      const skillPath = relDir === "" ? "SKILL.md" : `${relDir}/SKILL.md`;
      const parsed = parseSkillMd(content, { source, path: skillPath });
      if (!parsed) continue;

      if (relDir !== "") {
        const files: SkillRecord["files"] = [];
        collectSiblingFiles(absDir, absDir, files);
        if (files.length > 0) parsed.files = files;
      }

      results.push(parsed);
    }
    return results;
  } finally {
    await run("git", ["--git-dir", bareDir, "worktree", "remove", "--force", worktreeDir]).catch(() => {});
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

function collectSiblingFiles(root: string, dir: string, out: NonNullable<SkillRecord["files"]>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      collectSiblingFiles(root, path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name !== "SKILL.md" && entry.name !== ".git") {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (isProbablyBinaryPath(rel)) continue;
      out.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
    }
  }
}
