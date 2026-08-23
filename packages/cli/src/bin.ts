#!/usr/bin/env node
import { Command } from "commander";
import { Catalog, defaultCatalogPath } from "@skilljit/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@skilljit/mcp";
import { latestAdoption, resolveManagedUpstreams } from "@skilljit/proxy";
import { runSync } from "./commands/sync.js";
import { runSearch, formatSearchResults } from "./commands/search.js";
import { defaultStateDir, cmdInit, cmdAdopt, cmdRestore, cmdDoctor } from "./commands/proxy.js";

const program = new Command();

program
  .name("skilljit")
  .description(
    "Just-in-time skill and MCP tool routing for Claude. " +
      "Install thousands of skills at the token cost of one — nothing loads " +
      "into context until a task actually needs it.",
  )
  .version("0.1.0");

program
  .command("sync")
  .description("Refresh the local skill catalog from configured GitHub sources")
  .option("--db <path>", "catalog db path", defaultCatalogPath())
  .action(async (options: { db: string }) => {
    const result = await runSync({ dbPath: options.db, log: (l) => console.log(l) });
    console.log(`\nDone. ${result.total} skill(s) in catalog.`);
    if (result.failedSources.length > 0) {
      console.log(`${result.failedSources.length} source(s) failed to sync (see above).`);
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
