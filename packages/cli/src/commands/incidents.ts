import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileFn } from "@skilljit/core";

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
