import os from "node:os";
import path from "node:path";
import {
  runInit,
  runAdopt,
  runRestore,
  runDoctor,
  resolveManagedUpstreams,
  latestAdoption,
} from "@skilljit/proxy";

export function defaultStateDir(): string {
  return process.env.SKILLJIT_HOME ?? path.join(os.homedir(), ".skilljit");
}

export interface ProxyCliOptions {
  configPath: string;
  keep: string[];
  stateDir?: string;
}

export async function cmdInit(opts: ProxyCliOptions, log: (s: string) => void): Promise<void> {
  const result = await runInit({
    configPath: opts.configPath,
    stateDir: opts.stateDir ?? defaultStateDir(),
    passthroughServerNames: opts.keep,
  });
  log(`Proposed config written to ${result.proposedPath} (original untouched).\n`);
  log("Changes:");
  log(result.diff);
  log(`\n${result.routedServerNames.length} server(s) would be routed through skilljit: ${result.routedServerNames.join(", ") || "(none)"}`);
  log(`\nReview it, then run: skilljit adopt ${opts.configPath} --yes` + (opts.keep.length ? ` --keep ${opts.keep.join(",")}` : ""));
}

export async function cmdAdopt(opts: ProxyCliOptions & { yes?: boolean }, log: (s: string) => void): Promise<void> {
  if (!opts.yes) {
    log("This will rewrite your MCP config in place (a backup is kept for `skilljit restore`).");
    log("Re-run with --yes to proceed, or `skilljit init` first to preview the diff.");
    return;
  }
  const record = await runAdopt({
    configPath: opts.configPath,
    stateDir: opts.stateDir ?? defaultStateDir(),
    passthroughServerNames: opts.keep,
  });
  log(`Adopted. Backup saved to ${record.backupPath}.`);
  log(`Routed servers: ${record.routedServerNames.join(", ") || "(none)"}`);
  log(`Restart your MCP client, then run \`skilljit restore ${opts.configPath}\` any time to undo this.`);
}

export async function cmdRestore(configPath: string, stateDir: string | undefined, log: (s: string) => void): Promise<void> {
  await runRestore({ configPath, stateDir: stateDir ?? defaultStateDir() });
  log(`Restored ${configPath} to its pre-adopt state.`);
}

export async function cmdDoctor(configPath: string, stateDir: string | undefined, log: (s: string) => void): Promise<void> {
  const record = latestAdoption(stateDir ?? defaultStateDir(), configPath);
  if (!record) {
    log(`No skilljit adoption found for ${configPath}. Nothing to check — run \`skilljit init\` / \`adopt\` first.`);
    return;
  }
  const specs = resolveManagedUpstreams(record);
  if (specs.length === 0) {
    log("No routed upstream servers to check.");
    return;
  }
  const report = await runDoctor(specs);
  for (const [name, entry] of Object.entries(report)) {
    log(entry.ok ? `✓ ${name} — ${entry.toolCount} tool(s)` : `✗ ${name} — ${entry.error}`);
  }
}
