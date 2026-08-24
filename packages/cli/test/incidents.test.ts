import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readIncidentsConfig, writeIncidentsConfig, cmdIncidentsInit } from "../src/commands/incidents.js";

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
