import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UpstreamManager } from "../src/upstream.js";
import type { UpstreamSpec } from "../src/upstream.js";

/** Build a fake upstream MCP server and a connect function that links to it in-process. */
function fakeUpstream(name: string, toolName: string) {
  const server = new McpServer({ name, version: "0.0.0" });
  server.registerTool(
    toolName,
    { description: `demo tool on ${name}`, inputSchema: { x: z.string().optional() } },
    async ({ x }: { x?: string }) => ({ content: [{ type: "text" as const, text: `echo:${x ?? ""}` }] }),
  );
  return server;
}

async function connectToFake(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "skilljit-proxy-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("UpstreamManager", () => {
  it("lists tools across multiple upstreams, tagged with server name", async () => {
    const good = fakeUpstream("good-server", "ping");
    const specs: UpstreamSpec[] = [{ name: "good-server", command: "unused", args: [] }];
    const manager = new UpstreamManager(specs, async () => connectToFake(good));

    const tools = await manager.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].server).toBe("good-server");
    expect(tools[0].name).toBe("ping");

    await manager.closeAll();
  });

  it("isolates a dead upstream — other upstreams keep working and callTool gives a clean error", async () => {
    const good = fakeUpstream("good-server", "ping");
    const specs: UpstreamSpec[] = [
      { name: "good-server", command: "unused" },
      { name: "bad-server", command: "unused" },
    ];
    const connectFn = vi.fn(async (spec: UpstreamSpec) => {
      if (spec.name === "bad-server") throw new Error("spawn ENOENT");
      return connectToFake(good);
    });
    const manager = new UpstreamManager(specs, connectFn);

    const tools = await manager.listAllTools();
    expect(tools.map((t) => t.server)).toEqual(["good-server"]);
    expect(manager.getErrors()["bad-server"]).toMatch(/ENOENT/);

    const okResult = await manager.callTool("good-server", "ping", { x: "hi" });
    expect((okResult.content as any[])[0].text).toBe("echo:hi");

    await expect(manager.callTool("bad-server", "ping", {})).rejects.toThrow(/ENOENT|not available/i);
    // good-server is still fine after bad-server's failure
    const okAgain = await manager.callTool("good-server", "ping", { x: "still-fine" });
    expect((okAgain.content as any[])[0].text).toBe("echo:still-fine");

    await manager.closeAll();
  });

  it("gives a clean error calling an unknown server or unknown tool", async () => {
    const good = fakeUpstream("good-server", "ping");
    const manager = new UpstreamManager([{ name: "good-server", command: "unused" }], async () => connectToFake(good));
    await manager.listAllTools();

    await expect(manager.callTool("nope", "ping", {})).rejects.toThrow(/unknown server/i);
    // Calling a real server for a tool it doesn't have is a normal MCP tool
    // error (isError: true), not a transport-level rejection.
    const badToolResult = await manager.callTool("good-server", "nope", {});
    expect(badToolResult.isError).toBe(true);

    await manager.closeAll();
  });
});
