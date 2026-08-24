import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Catalog } from "@skilljit/core";
import { createServer } from "../src/server.js";

describe("skilljit MCP server — incidents", () => {
  let dbPath: string;
  let dir: string;
  let client: Client;
  let handle: ReturnType<typeof createServer>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-incidents-"));
    dbPath = path.join(dir, "catalog.db");
    const seed = new Catalog(dbPath);
    seed.upsertIncidents([
      {
        id: "git:acme/webapp/incidents/a1b2c3d",
        symptom: "Checkout requests time out under load after a deploy.",
        investigation: "Ruled out the payment provider. Traced it to a migration holding a lock.",
        rootCause: "ACCESS EXCLUSIVE lock on a hot table.",
        fix: "Reran the migration with CREATE INDEX CONCURRENTLY.",
        commitSha: "a1b2c3d4e5f6",
        repo: "git:git@example.com:acme/webapp.git",
        capturedAt: "2026-08-24T12:00:00.000Z",
        verified: false,
      },
      {
        id: "git:acme/webapp/incidents/f00d1e5",
        symptom: "Nightly export job silently drops the last batch of rows.",
        investigation: "Confirmed the batch loop's off-by-one on the final page.",
        rootCause: "Pagination cursor advanced past the last page before flushing it.",
        fix: "Flush the current page before checking for a next one.",
        commitSha: "f00d1e5abcde",
        repo: "git:git@example.com:acme/webapp.git",
        capturedAt: "2026-08-24T13:00:00.000Z",
        verified: true,
      },
    ]);
    seed.close();

    handle = createServer({ catalogPath: dbPath, incidentsCatalogPath: dbPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    handle.catalog.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes incident_find and incident_load when incidents are configured", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("incident_find");
    expect(names).toContain("incident_load");
  });

  it("incident_find returns cheap candidates without investigation/fix", async () => {
    const result = await client.callTool({ name: "incident_find", arguments: { symptom: "checkout timeout" } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("a1b2c3d");
    expect(text).not.toContain("CREATE INDEX CONCURRENTLY");
  });

  it("incident_load returns the full record and warns it's unverified", async () => {
    const result = await client.callTool({
      name: "incident_load",
      arguments: { id: "git:acme/webapp/incidents/a1b2c3d" },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("CREATE INDEX CONCURRENTLY");
    expect(text).toContain("not been reviewed by a human");
  });

  it("incident_load reports a clean error for an unknown id", async () => {
    const result = await client.callTool({ name: "incident_load", arguments: { id: "nope/nope" } });
    expect(result.isError).toBe(true);
  });

  it("incident_load omits the unverified warning for a verified incident", async () => {
    const result = await client.callTool({
      name: "incident_load",
      arguments: { id: "git:acme/webapp/incidents/f00d1e5" },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("Flush the current page before checking for a next one.");
    expect(text).not.toContain("not been reviewed by a human");
  });
});

describe("skilljit MCP server — incidents in a separate catalog file", () => {
  it("serves incident_find/incident_load from a distinct db and exposes it as incidentsCatalog for closing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-separate-incidents-"));
    const skillsDbPath = path.join(dir, "skills.db");
    const incidentsDbPath = path.join(dir, "incidents.db");
    new Catalog(skillsDbPath).close();
    const seed = new Catalog(incidentsDbPath);
    seed.upsertIncidents([
      {
        id: "git:acme/webapp/incidents/a1b2c3d",
        symptom: "Checkout requests time out under load after a deploy.",
        investigation: "Ruled out the payment provider. Traced it to a migration holding a lock.",
        rootCause: "ACCESS EXCLUSIVE lock on a hot table.",
        fix: "Reran the migration with CREATE INDEX CONCURRENTLY.",
        commitSha: "a1b2c3d4e5f6",
        repo: "git:git@example.com:acme/webapp.git",
        capturedAt: "2026-08-24T12:00:00.000Z",
        verified: false,
      },
    ]);
    seed.close();

    const handle = createServer({ catalogPath: skillsDbPath, incidentsCatalogPath: incidentsDbPath });
    expect(handle.incidentsCatalog).toBeDefined();
    expect(handle.incidentsCatalog).not.toBe(handle.catalog);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);

    const findResult = await client.callTool({ name: "incident_find", arguments: { symptom: "checkout timeout" } });
    const findText = (findResult.content as any[])[0].text as string;
    expect(findText).toContain("a1b2c3d");

    const loadResult = await client.callTool({
      name: "incident_load",
      arguments: { id: "git:acme/webapp/incidents/a1b2c3d" },
    });
    const loadText = (loadResult.content as any[])[0].text as string;
    expect(loadText).toContain("CREATE INDEX CONCURRENTLY");

    await client.close();
    handle.catalog.close();
    handle.incidentsCatalog!.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("skilljit MCP server without incidents configured", () => {
  it("does not expose incident_find/incident_load", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-no-incidents-"));
    const dbPath = path.join(dir, "catalog.db");
    new Catalog(dbPath).close();

    const handle = createServer({ catalogPath: dbPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("incident_find");

    await client.close();
    handle.catalog.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
