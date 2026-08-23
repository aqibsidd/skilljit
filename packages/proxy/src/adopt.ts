import fs from "node:fs";
import path from "node:path";
import { readMcpConfig, proposeConfig, diffConfigs } from "./config.js";
import type { McpClientConfig } from "./config.js";

export interface StateFile {
  adoptions: AdoptionRecord[];
}

export interface AdoptionRecord {
  configPath: string;
  backupPath: string;
  adoptedAt: string;
  routedServerNames: string[];
  passthroughServerNames: string[];
}

interface LifecycleOptions {
  configPath: string;
  /** Where skilljit keeps backups + its state.json — defaults to ~/.skilljit, injectable for tests. */
  stateDir: string;
  passthroughServerNames: string[];
  skilljitCommand?: string;
  skilljitArgs?: string[];
  now?: () => string;
}

const DEFAULT_SKILLJIT_COMMAND = "npx";
const DEFAULT_SKILLJIT_ARGS = ["-y", "skilljit", "serve"];

function statePath(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

function loadState(stateDir: string): StateFile {
  const p = statePath(stateDir);
  if (!fs.existsSync(p)) return { adoptions: [] };
  return JSON.parse(fs.readFileSync(p, "utf8")) as StateFile;
}

function saveState(stateDir: string, state: StateFile): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2));
}

function buildProposal(configPath: string, passthroughServerNames: string[], skilljitCommand: string, skilljitArgs: string[]) {
  const original = readMcpConfig(configPath);
  const proposed = proposeConfig(original, { skilljitCommand, skilljitArgs, passthroughServerNames });
  const diff = diffConfigs(original, proposed.config);
  return { original, proposed, diff };
}

export interface InitResult {
  proposedPath: string;
  diff: string;
  routedServerNames: string[];
}

/** Never mutates configPath. Writes the proposed config next to it and returns a diff to review. */
export async function runInit(opts: LifecycleOptions): Promise<InitResult> {
  const { proposed, diff } = buildProposal(
    opts.configPath,
    opts.passthroughServerNames,
    opts.skilljitCommand ?? DEFAULT_SKILLJIT_COMMAND,
    opts.skilljitArgs ?? DEFAULT_SKILLJIT_ARGS,
  );
  const proposedPath = `${opts.configPath}.skilljit-proposed.json`;
  fs.writeFileSync(proposedPath, JSON.stringify(proposed.config, null, 2));
  return { proposedPath, diff, routedServerNames: proposed.routedServerNames };
}

/** The one action that mutates the live config: backs up the original, writes
 * the routed config in its place, and records the adoption so `restore` can
 * undo it later. */
export async function runAdopt(opts: LifecycleOptions): Promise<AdoptionRecord> {
  const { original, proposed } = buildProposal(
    opts.configPath,
    opts.passthroughServerNames,
    opts.skilljitCommand ?? DEFAULT_SKILLJIT_COMMAND,
    opts.skilljitArgs ?? DEFAULT_SKILLJIT_ARGS,
  );

  const now = (opts.now ?? (() => new Date().toISOString()))();
  const backupDir = path.join(opts.stateDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(opts.configPath)}.${now.replace(/[:.]/g, "-")}.bak.json`);
  fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));

  fs.writeFileSync(opts.configPath, JSON.stringify(proposed.config, null, 2));

  const record: AdoptionRecord = {
    configPath: path.resolve(opts.configPath),
    backupPath,
    adoptedAt: now,
    routedServerNames: proposed.routedServerNames,
    passthroughServerNames: opts.passthroughServerNames,
  };
  const state = loadState(opts.stateDir);
  state.adoptions.push(record);
  saveState(opts.stateDir, state);
  return record;
}

/** Undo the most recent adopt for this configPath, restoring the backed-up original. */
export async function runRestore(opts: Pick<LifecycleOptions, "configPath" | "stateDir">): Promise<void> {
  const state = loadState(opts.stateDir);
  const resolvedTarget = path.resolve(opts.configPath);
  const idx = [...state.adoptions].reverse().findIndex((a) => a.configPath === resolvedTarget);
  if (idx === -1) {
    throw new Error(
      `No skilljit adoption found for ${opts.configPath}. Nothing to restore — was it adopted with a different --db/--state-dir?`,
    );
  }
  const record = state.adoptions[state.adoptions.length - 1 - idx];
  if (!fs.existsSync(record.backupPath)) {
    throw new Error(`Backup ${record.backupPath} is missing — cannot safely restore.`);
  }
  const backup = fs.readFileSync(record.backupPath, "utf8");
  fs.writeFileSync(opts.configPath, backup);

  state.adoptions.splice(state.adoptions.length - 1 - idx, 1);
  saveState(opts.stateDir, state);
}

/** The specs of the servers skilljit is currently routing for a given config,
 * reconstructed from the backup (the live config no longer has them — they
 * were replaced by the single "skilljit" entry). Used by `skilljit doctor`. */
export function resolveManagedUpstreams(record: AdoptionRecord): { name: string; command: string; args?: string[]; env?: Record<string, string> }[] {
  const backup = readMcpConfig(record.backupPath);
  return record.routedServerNames
    .filter((name) => backup.mcpServers[name])
    .map((name) => ({ name, ...backup.mcpServers[name] }));
}

export function latestAdoption(stateDir: string, configPath: string): AdoptionRecord | undefined {
  const state = loadState(stateDir);
  const resolvedTarget = path.resolve(configPath);
  return [...state.adoptions].reverse().find((a) => a.configPath === resolvedTarget);
}

export type { McpClientConfig };
