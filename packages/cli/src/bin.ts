#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { Catalog, defaultCatalogPath, DEFAULT_GITHUB_SOURCES } from "@skilljit/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@skilljit/mcp";
import { latestAdoption, resolveManagedUpstreams } from "@skilljit/proxy";
import { runSync } from "./commands/sync.js";
import { runSearch, formatSearchResults } from "./commands/search.js";
import { defaultStateDir, cmdInit, cmdAdopt, cmdRestore, cmdDoctor } from "./commands/proxy.js";
import { cmdIncidentsInit, cmdIncidentsInstallHook, runCaptureIncident } from "./commands/incidents.js";

// Read the real version from this package's own package.json rather than
// hardcoding a string here that silently drifts from every release.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version: packageVersion } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("skilljit")
  .description(
    "Just-in-time skill and MCP tool routing for Claude. " +
      "Install thousands of skills at the token cost of one — nothing loads " +
      "into context until a task actually needs it.",
  )
  .version(packageVersion);

function parseRepoSlug(value: string, previous: { owner: string; repo: string }[]): { owner: string; repo: string }[] {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`--repo expects "owner/repo", got "${value}"`);
  }
  return [...previous, { owner: value.slice(0, slash), repo: value.slice(slash + 1) }];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command("sync")
  .description("Refresh the local skill catalog from configured GitHub sources")
  .option("--db <path>", "catalog db path", defaultCatalogPath())
  .option(
    "--repo <owner/repo>",
    "additional GitHub repo to sync, on top of the built-in defaults (repeatable)",
    parseRepoSlug,
    [] as { owner: string; repo: string }[],
  )
  .option(
    "--git <url>",
    "arbitrary git remote to sync via clone + worktree — self-hosted, GitLab, or an " +
      "SSH-authenticated private repo, using whatever git credentials are already set up " +
      "on this machine (repeatable, no GitHub API token needed)",
    collect,
    [] as string[],
  )
  .option("--token <token>", "GitHub token for --repo sources (or set SKILLJIT_GITHUB_TOKEN)")
  .action(async (options: { db: string; repo: { owner: string; repo: string }[]; git: string[]; token?: string }) => {
    const sources = [...DEFAULT_GITHUB_SOURCES, ...options.repo];
    const result = await runSync({
      dbPath: options.db,
      sources,
      gitSources: options.git,
      token: options.token,
      stateDir: defaultStateDir(),
      log: (l) => console.log(l),
    });
    console.log(`\nDone. ${result.total} skill(s) in catalog.`);
    if (result.failedSources.length > 0) {
      console.log(`${result.failedSources.length} GitHub source(s) failed to sync (see above).`);
    }
    if (result.failedGitSources.length > 0) {
      console.log(`${result.failedGitSources.length} git source(s) failed to sync (see above).`);
    }
  });

program
  .command("search <query>")
  .description("Search the local skill catalog (no network, no context cost)")
  .option("--db <path>", "catalog db path", defaultCatalogPath())
  .option("-n, --limit <n>", "max results", "8")
  .action((query: string, options: { db: string; limit: string }) => {
    const hits = runSearch({ dbPath: options.db, query, limit: Number(options.limit) });
    console.log(formatSearchResults(hits));
  });

program
  .command("serve")
  .description("Run the skilljit MCP stdio server (this is what your MCP client config should launch)")
  .option("--db <path>", "catalog db path", defaultCatalogPath())
  .option("--config <path>", "MCP client config previously passed to `skilljit adopt`, to enable tool_find/tool_call")
  .action(async (options: { db: string; config?: string }) => {
    let upstreams;
    if (options.config) {
      const record = latestAdoption(defaultStateDir(), options.config);
      if (record) upstreams = resolveManagedUpstreams(record);
    }
    const { server } = createServer({ catalogPath: options.db, upstreams });
    await server.connect(new StdioServerTransport());
  });

program
  .command("stats")
  .description("Print current catalog size (token savings accrue per-session inside a running MCP connection)")
  .option("--db <path>", "catalog db path", defaultCatalogPath())
  .action((options: { db: string }) => {
    const catalog = new Catalog(options.db);
    console.log(`${catalog.count()} skill(s) in local catalog (${options.db}).`);
    console.log("Run `skilljit serve` and call the skilljit_stats tool from your MCP client for live savings.");
    catalog.close();
  });

function parseKeepList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

program
  .command("init <configPath>")
  .description(
    "Preview adopting an MCP client config (e.g. claude_desktop_config.json) into skilljit — never touches the original file",
  )
  .option("--keep <names>", "comma-separated server names to leave untouched (fully visible, no routing)", parseKeepList, [])
  .action(async (configPath: string, options: { keep: string[] }) => {
    await cmdInit({ configPath, keep: options.keep }, (l) => console.log(l));
  });

program
  .command("adopt <configPath>")
  .description("Route servers in an MCP client config through skilljit (backs up the original first)")
  .option("--keep <names>", "comma-separated server names to leave untouched", parseKeepList, [])
  .option("--yes", "actually write the change (otherwise this is a dry run)")
  .action(async (configPath: string, options: { keep: string[]; yes?: boolean }) => {
    await cmdAdopt({ configPath, keep: options.keep, yes: options.yes }, (l) => console.log(l));
  });

program
  .command("restore <configPath>")
  .description("Undo `skilljit adopt` — restores the config from its backup")
  .action(async (configPath: string) => {
    await cmdRestore(configPath, undefined, (l) => console.log(l));
  });

program
  .command("doctor [configPath]")
  .description("Check that every upstream MCP server skilljit is routing for a config still spawns and lists tools")
  .action(async (configPath?: string) => {
    if (!configPath) {
      console.log("Usage: skilljit doctor <configPath> (the config previously passed to `skilljit adopt`)");
      return;
    }
    await cmdDoctor(configPath, undefined, (l) => console.log(l));
  });

const incidentsCmd = program.command("incidents").description("Capture and share debugging context across a team");

incidentsCmd
  .command("init <repoUrl>")
  .description("Configure the git repo incidents are captured to and synced from")
  .action(async (repoUrl: string) => {
    await cmdIncidentsInit({ repoUrl, stateDir: defaultStateDir() }, (l) => console.log(l));
  });

incidentsCmd
  .command("install-hook")
  .description("Install the PostToolUse hook that captures incidents on fix-like git commits")
  .option("--yes", "actually write the change (otherwise this is a dry run)")
  .option("--settings-path <path>", "settings.json path", path.join(os.homedir(), ".claude", "settings.json"))
  .action(async (options: { yes?: boolean; settingsPath: string }) => {
    await cmdIncidentsInstallHook({ settingsPath: options.settingsPath, yes: options.yes }, (l) => console.log(l));
  });

program
  .command("capture-incident", { hidden: true })
  .description("Internal: invoked by the PostToolUse hook, reads its JSON payload from stdin")
  .action(async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await runCaptureIncident(payload, { stateDir: defaultStateDir() });
    if (result.captured) console.log(`skilljit: ${result.reason}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
