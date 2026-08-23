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
      {
        id: "acme/repo/docker-expert",
        name: "docker-expert",
        source: "github:acme/repo",
        description: "Write production Dockerfiles.",
        body: "# Docker\n\nSee references/checklist.md for the full checklist.",
        files: [{ path: "references/checklist.md", content: "- pin base image digest\n- multi-stage build" }],
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
    expect(names).toEqual(["skill_find", "skill_load", "skill_read_file", "skilljit_stats"]);
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

  it("skill_load lists bundled files without inlining their content", async () => {
    const result = await client.callTool({ name: "skill_load", arguments: { name: "acme/repo/docker-expert" } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("references/checklist.md");
    expect(text).not.toContain("pin base image digest");
  });

  it("skill_read_file loads one bundled file's content by path", async () => {
    const result = await client.callTool({
      name: "skill_read_file",
      arguments: { name: "acme/repo/docker-expert", path: "references/checklist.md" },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("pin base image digest");
  });

  it("skill_read_file reports a clean error for an unknown path", async () => {
    const result = await client.callTool({
      name: "skill_read_file",
      arguments: { name: "acme/repo/docker-expert", path: "scripts/nope.sh" },
    });
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

  it("skilljit_stats reports an all-time total, separate from this session's own numbers", async () => {
    const result = await client.callTool({ name: "skilljit_stats", arguments: {} });
    const stats = JSON.parse((result.content as any[])[0].text);
    expect(stats.allTime.sessionCount).toBe(1);
    expect(stats.allTime.baselineTokens).toBe(stats.baselineTokens);
  });

  it("all-time totals accumulate across two tabs sharing the same catalog, and survive one tab closing", async () => {
    // "Tab 2" opens against the same catalog.db this suite's beforeEach already seeded.
    const handle2 = createServer({ catalogPath: dbPath });
    const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-client-2", version: "0.0.0" });
    await Promise.all([client2.connect(clientTransport2), handle2.server.connect(serverTransport2)]);

    await client2.callTool({ name: "skill_find", arguments: { query: "docker" } });

    // "Tab 2" is lost — closed without a graceful shutdown hook, same as a killed process.
    await client2.close();
    handle2.catalog.close();

    // Tab 1 (still open) should see combined totals: 2 sessions, and both
    // tabs' baseline contributions, even though tab 2 is gone.
    const result = await client.callTool({ name: "skilljit_stats", arguments: {} });
    const stats = JSON.parse((result.content as any[])[0].text);
    expect(stats.allTime.sessionCount).toBe(2);
    expect(stats.allTime.baselineTokens).toBe(stats.baselineTokens * 2);
    expect(stats.allTime.actualTokens).toBeGreaterThan(stats.actualTokens); // tab 2's skill_find call is in there too
  });
});
