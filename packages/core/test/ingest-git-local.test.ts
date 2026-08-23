import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestLocalGitRepo } from "../src/ingest/git-local.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeSkill(repoDir: string, relDir: string, body: string, files: Record<string, string> = {}): void {
  const dir = path.join(repoDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

function commitAll(repoDir: string, message: string): void {
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "-q", "-m", message]);
}

const SKILL_MD_V1 = `---
name: docker-expert
description: Write production Dockerfiles.
---
v1 body`;

const SKILL_MD_V2 = `---
name: docker-expert
description: Write production Dockerfiles.
---
v2 body`;

describe("ingestLocalGitRepo", () => {
  let srcRepo: string;
  let cacheDir: string;

  beforeEach(() => {
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-src-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cache-"));
    git(srcRepo, ["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    fs.rmSync(srcRepo, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("ingests a skill and its bundled files from a local git remote", async () => {
    writeSkill(srcRepo, "skills/docker-expert", SKILL_MD_V1, { "references/checklist.md": "- pin base image" });
    commitAll(srcRepo, "add skill");

    const skills = await ingestLocalGitRepo(srcRepo, { cacheDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("docker-expert");
    expect(skills[0].body).toContain("v1 body");
    expect(skills[0].source).toBe(`git:${srcRepo}`);
    expect(skills[0].files).toEqual([{ path: "references/checklist.md", content: "- pin base image" }]);
  });

  it("a second sync fetches new commits instead of serving stale cached content", async () => {
    writeSkill(srcRepo, "skills/docker-expert", SKILL_MD_V1);
    commitAll(srcRepo, "v1");
    const first = await ingestLocalGitRepo(srcRepo, { cacheDir });
    expect(first[0].body).toContain("v1 body");

    writeSkill(srcRepo, "skills/docker-expert", SKILL_MD_V2);
    commitAll(srcRepo, "v2");
    const second = await ingestLocalGitRepo(srcRepo, { cacheDir });
    expect(second[0].body).toContain("v2 body");
  });

  it("skips file-bundling for a SKILL.md sitting at the repo root", async () => {
    writeSkill(srcRepo, ".", SKILL_MD_V1);
    fs.writeFileSync(path.join(srcRepo, "unrelated.txt"), "not part of the skill");
    commitAll(srcRepo, "root skill");

    const skills = await ingestLocalGitRepo(srcRepo, { cacheDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].files).toBeUndefined();
  });

  it("cleans up its temporary worktree after ingestion", async () => {
    writeSkill(srcRepo, "skills/docker-expert", SKILL_MD_V1);
    commitAll(srcRepo, "v1");
    await ingestLocalGitRepo(srcRepo, { cacheDir });

    const bareDirs = fs.readdirSync(cacheDir);
    expect(bareDirs).toHaveLength(1);
    const worktrees = execFileSync("git", ["--git-dir", path.join(cacheDir, bareDirs[0]), "worktree", "list"], {
      encoding: "utf8",
    });
    expect(worktrees.trim().split("\n")).toHaveLength(1); // only the bare repo itself, no leftover worktree
  });
});
