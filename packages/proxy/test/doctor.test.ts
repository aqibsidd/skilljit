import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runDoctor } from "../src/doctor.js";
import type { UpstreamSpec } from "../src/upstream.js";

function fakeUpstream(name: string) {
  const server = new McpServer({ name, version: "0.0.0" });
  server.registerTool("noop", { inputSchema: { z: z.string().optional() } }, async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  return server;
}

async function connectToFake(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "doctor-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("runDoctor", () => {
  it("reports ok + tool count for healthy upstreams and a clear error for broken ones", async () => {
    const healthy = fakeUpstream("healthy");
    const specs: UpstreamSpec[] = [
      { name: "healthy", command: "unused" },
      { name: "broken", command: "unused" },
    ];
    const report = await runDoctor(specs, async (spec) => {
      if (spec.name === "broken") throw new Error("spawn ENOENT: no such file");
      return connectToFake(healthy);
    });

    expect(report.healthy.ok).toBe(true);
    expect(report.healthy.toolCount).toBe(1);
    expect(report.broken.ok).toBe(false);
    expect(report.broken.error).toMatch(/ENOENT/);
  });
});
