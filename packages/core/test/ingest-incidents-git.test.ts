import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestIncidentsFromGitRepo } from "../src/ingest/incidents-git.js";
import { serializeIncidentMd } from "../src/ingest/incident-md.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("ingestIncidentsFromGitRepo", () => {
  let srcRepo: string;
  let cacheDir: string;

  beforeEach(() => {
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-src-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cache-"));
    git(srcRepo, ["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    fs.rmSync(srcRepo, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("ingests every incident file under incidents/", async () => {
    fs.mkdirSync(path.join(srcRepo, "incidents"));
    const md = serializeIncidentMd({
      symptom: "Checkout requests time out under load after a deploy.",
      investigation: "Traced it to a migration holding a lock.",
      rootCause: "ACCESS EXCLUSIVE lock on a hot table.",
      fix: "Reran with CREATE INDEX CONCURRENTLY.",
      commitSha: "a1b2c3d4e5f6",
      repo: `git:${srcRepo}`,
      capturedAt: "2026-08-24T12:00:00.000Z",
      verified: false,
    });
    fs.writeFileSync(path.join(srcRepo, "incidents", "2026-08-24-a1b2c3d.md"), md);
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add incident"]);

    const incidents = await ingestIncidentsFromGitRepo(srcRepo, { cacheDir });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].symptom).toContain("Checkout requests time out");
    expect(incidents[0].id).toBe(`git:${srcRepo}/incidents/a1b2c3d`);
  });

  it("ignores non-incident files under incidents/ and files outside it", async () => {
    fs.mkdirSync(path.join(srcRepo, "incidents"));
    fs.writeFileSync(path.join(srcRepo, "incidents", "README.md"), "# not an incident, no frontmatter");
    fs.writeFileSync(path.join(srcRepo, "unrelated.md"), "---\nsymptom: x\n---\nnot in incidents/");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add noise"]);

    const incidents = await ingestIncidentsFromGitRepo(srcRepo, { cacheDir });
    expect(incidents).toHaveLength(0);
  });

  it("returns an empty array when there is no incidents/ directory at all", async () => {
    fs.writeFileSync(path.join(srcRepo, "README.md"), "# empty repo");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

    const incidents = await ingestIncidentsFromGitRepo(srcRepo, { cacheDir });
    expect(incidents).toEqual([]);
  });
});
