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

export interface WithGitWorktreeOptions {
  cacheDir?: string;
  ref?: string;
  execFileImpl?: ExecFileFn;
}

/**
 * Clone (or reuse a cached bare mirror of) an arbitrary git remote, check
 * out a throwaway worktree, hand its path to `scan`, then clean up —
 * regardless of whether `scan` throws. Shared by every content type that
 * gets ingested from a git remote (skills today, incidents in Task 6),
 * so the clone/fetch/worktree mechanics exist exactly once.
 */
export async function withGitWorktree<T>(
  url: string,
  opts: WithGitWorktreeOptions,
  scan: (worktreeDir: string) => T | Promise<T>,
): Promise<T> {
  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".skilljit", "git-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bareDir = path.join(cacheDir, `${cacheKeyForUrl(url)}.git`);

  if (!fs.existsSync(bareDir)) {
    await run("git", ["clone", "--mirror", "--quiet", url, bareDir]);
  } else {
    await run("git", ["--git-dir", bareDir, "fetch", "--quiet", "--prune", "origin"]);
  }

  const checkoutRef = opts.ref ?? "HEAD";
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-wt-"));
  fs.rmdirSync(worktreeDir);

  try {
    await run("git", ["--git-dir", bareDir, "worktree", "add", "--detach", "--quiet", worktreeDir, checkoutRef]);
    return await scan(worktreeDir);
  } finally {
    await run("git", ["--git-dir", bareDir, "worktree", "remove", "--force", worktreeDir]).catch(() => {});
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

export interface LocalGitIngestOptions extends WithGitWorktreeOptions {}

/**
 * Ingest every SKILL.md in an arbitrary git repository — self-hosted,
 * GitLab, Bitbucket, an internal server, or a private GitHub repo reached
 * over SSH — anywhere the `git` binary on this machine can already
 * authenticate. See withGitWorktree for the clone/fetch/worktree mechanics
 * this reuses.
 */
export async function ingestLocalGitRepo(
  url: string,
  opts: LocalGitIngestOptions = {},
): Promise<SkillRecord[]> {
  const source = `git:${url}`;
  return withGitWorktree(url, opts, (worktreeDir) => {
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
  });
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
