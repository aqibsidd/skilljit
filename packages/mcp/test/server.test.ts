import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Catalog } from "@skilljit/core";
import { createServer } from "../src/server.js";

describe("skilljit MCP server", () => {
  let dbPath: string;
  let dir: string;
  let client: Client;
  let handle: ReturnType<typeof createServer>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-"));
    dbPath = path.join(dir, "catalog.db");
    const seed = new Catalog(dbPath);
    seed.upsertSkills([
      {
        id: "acme/repo/postgres-migrate",
        name: "postgres-migrate",
        source: "github:acme/repo",
        description: "Plan and run zero-downtime Postgres schema migrations.",
        body: "# Postgres migrations\n\nUse a shadow table for large backfills.",
        updatedAt: "2026-01-01T00:00:00.000Z",
        auditStatus: "pass",
      },
      {
        id: "acme/repo/pdf-processing",
        name: "pdf-processing",
        source: "github:acme/repo",
        description: "Extract text and tables from PDF files.",
        body: "# PDF processing\n\nUse pdfplumber.",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    seed.close();

    handle = createServer({ catalogPath: dbPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    handle.catalog.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes exactly the fixed skills-half tool surface", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["skill_find", "skill_load", "skilljit_stats"]);
  });

  it("skill_find returns cheap candidates without full bodies", async () => {
    const result = await client.callTool({ name: "skill_find", arguments: { query: "postgres migration" } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("postgres-migrate");
    expect(text).not.toContain("shadow table");
  });

  it("skill_load returns the full body for a named skill", async () => {
    const result = await client.callTool({
      name: "skill_load",
      arguments: { name: "acme/repo/postgres-migrate" },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("shadow table");
  });

  it("skill_load reports an error for an unknown skill instead of throwing raw", async () => {
    const result = await client.callTool({ name: "skill_load", arguments: { name: "nope/nope" } });
    expect(result.isError).toBe(true);
  });

  it("skilljit_stats reports non-negative savings that grow as skills are used", async () => {
    const before = await client.callTool({ name: "skilljit_stats", arguments: {} });
    const beforeText = (before.content as any[])[0].text as string;
    const beforeStats = JSON.parse(beforeText);
    expect(beforeStats.savedTokens).toBeGreaterThanOrEqual(0);

    await client.callTool({ name: "skill_find", arguments: { query: "postgres" } });

    const after = await client.callTool({ name: "skilljit_stats", arguments: {} });
    const afterStats = JSON.parse((after.content as any[])[0].text);
    expect(afterStats.baselineTokens).toBe(beforeStats.baselineTokens);
    expect(afterStats.actualTokens).toBeGreaterThan(beforeStats.actualTokens);
  });
});
