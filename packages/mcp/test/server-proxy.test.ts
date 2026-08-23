import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { UpstreamSpec } from "@skilljit/proxy";
import { Catalog } from "@skilljit/core";
import { createServer } from "../src/server.js";

function fakePostgresUpstream() {
  const server = new McpServer({ name: "postgres-mcp", version: "0.0.0" });
  server.registerTool(
    "run_migration",
    { description: "Run a Postgres schema migration.", inputSchema: { sql: z.string() } },
    async ({ sql }: { sql: string }) => ({ content: [{ type: "text" as const, text: `ran: ${sql}` }] }),
  );
  return server;
}

describe("skilljit MCP server — proxy mode (skills + tool routing)", () => {
  let dir: string;
  let dbPath: string;
  let client: Client;
  let handle: ReturnType<typeof createServer>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-proxy-"));
    dbPath = path.join(dir, "catalog.db");
    new Catalog(dbPath).close();

    const upstreams: UpstreamSpec[] = [{ name: "postgres-mcp", command: "unused" }];
    const fakeServer = fakePostgresUpstream();
    handle = createServer({
      catalogPath: dbPath,
      upstreams,
      connectFn: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "skilljit-proxy-internal", version: "0.0.0" });
        await Promise.all([c.connect(clientTransport), fakeServer.connect(serverTransport)]);
        return c;
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await handle.upstreams?.closeAll();
    handle.catalog.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes all six fixed tools when upstreams are configured", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "skill_find",
      "skill_load",
      "skill_read_file",
      "skilljit_stats",
      "tool_call",
      "tool_find",
    ]);
  });

  it("tool_find finds an upstream tool by description, without a static schema dump at startup", async () => {
    const result = await client.callTool({ name: "tool_find", arguments: { query: "postgres migration" } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("run_migration");
    expect(text).toContain("postgres-mcp");
  });

  it("tool_call routes to the right upstream and returns its real result", async () => {
    const result = await client.callTool({
      name: "tool_call",
      arguments: { server: "postgres-mcp", tool: "run_migration", args: { sql: "ALTER TABLE x ADD COLUMN y" } },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("ran: ALTER TABLE x ADD COLUMN y");
  });

  it("tool_call gives a clean error for an unknown upstream server", async () => {
    const result = await client.callTool({
      name: "tool_call",
      arguments: { server: "nonexistent-mcp", tool: "whatever", args: {} },
    });
    expect(result.isError).toBe(true);
  });
});
