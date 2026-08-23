import fs from "node:fs";

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The de facto MCP client config shape used by Claude Desktop, Claude Code
 * project `.mcp.json`, and Cursor: a flat map of server name to launch spec. */
export interface McpClientConfig {
  mcpServers: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function readMcpConfig(path: string): McpClientConfig {
  if (!fs.existsSync(path)) {
    throw new Error(`No MCP config found at ${path}. Create one first, or pass --db-only to skip adoption.`);
  }
  const raw = fs.readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || !("mcpServers" in parsed)) {
    throw new Error(`${path} doesn't look like an MCP client config (missing "mcpServers").`);
  }
  return parsed as McpClientConfig;
}

export interface ProposeOptions {
  skilljitCommand: string;
  skilljitArgs: string[];
  /** Server names that should stay directly visible instead of being routed through skilljit. */
  passthroughServerNames: string[];
}

export interface ProposedConfig {
  config: McpClientConfig;
  /** Servers that would move under skilljit's tool_find/tool_call routing. */
  routedServerNames: string[];
}

/**
 * Compute (without writing anything) what a config would look like after
 * adopting skilljit: passthrough servers are left exactly as-is, everything
 * else is removed and replaced by one "skilljit" entry. Pure function —
 * `adopt()` is the only place that touches disk.
 */
export function proposeConfig(original: McpClientConfig, opts: ProposeOptions): ProposedConfig {
  const passthrough = new Set(opts.passthroughServerNames);
  const mcpServers: Record<string, McpServerEntry> = {};
  const routedServerNames: string[] = [];

  for (const [name, entry] of Object.entries(original.mcpServers)) {
    if (passthrough.has(name)) {
      mcpServers[name] = entry;
    } else {
      routedServerNames.push(name);
    }
  }
  mcpServers["skilljit"] = { command: opts.skilljitCommand, args: opts.skilljitArgs };

  return {
    config: { ...original, mcpServers },
    routedServerNames,
  };
}

/** A small, deliberately plain-text diff — this config is tiny (a handful of
 * server entries), so a line-level +/- summary is more legible here than
 * pulling in a diff library. */
export function diffConfigs(before: McpClientConfig, after: McpClientConfig): string {
  const beforeNames = Object.keys(before.mcpServers).sort();
  const afterNames = Object.keys(after.mcpServers).sort();
  const removed = beforeNames.filter((n) => !afterNames.includes(n));
  const added = afterNames.filter((n) => !beforeNames.includes(n));
  const unchanged = beforeNames.filter((n) => afterNames.includes(n));

  const lines: string[] = [];
  for (const n of removed) lines.push(`- ${n}`);
  for (const n of added) lines.push(`+ ${n}`);
  for (const n of unchanged) lines.push(`  ${n} (unchanged)`);
  return lines.join("\n");
}
