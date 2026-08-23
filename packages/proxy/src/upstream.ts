import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolRecord } from "@skilljit/core";

export interface UpstreamSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type ConnectFn = (spec: UpstreamSpec) => Promise<Client>;

async function defaultConnect(spec: UpstreamSpec): Promise<Client> {
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env });
  const client = new Client({ name: `skilljit-proxy(${spec.name})`, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/**
 * Manages connections to upstream MCP servers on skilljit's behalf, so
 * tool_find/tool_call can route to them without their schemas ever sitting
 * in the static tool list. One upstream failing to spawn or dying mid-session
 * must not take the others down — that isolation is the whole point of a
 * proxy layer, so every method here treats per-server failure as data, not
 * an exception that propagates past its own server's boundary.
 */
export class UpstreamManager {
  private clients = new Map<string, Client>();
  private errors = new Map<string, string>();

  constructor(
    private specs: UpstreamSpec[],
    private connectFn: ConnectFn = defaultConnect,
  ) {}

  private async ensureConnected(name: string): Promise<Client | null> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return null;
    try {
      const client = await this.connectFn(spec);
      this.clients.set(name, client);
      this.errors.delete(name);
      return client;
    } catch (err) {
      this.errors.set(name, (err as Error).message);
      return null;
    }
  }

  /** List tools from every upstream, tagging each with its server name. Servers that
   * fail to connect are skipped (see getErrors()) rather than aborting the whole scan. */
  async listAllTools(): Promise<ToolRecord[]> {
    const results: ToolRecord[] = [];
    for (const spec of this.specs) {
      const client = await this.ensureConnected(spec.name);
      if (!client) continue;
      try {
        const { tools } = await client.listTools();
        for (const t of tools) {
          results.push({
            id: `${spec.name}:${t.name}`,
            server: spec.name,
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        this.errors.set(spec.name, (err as Error).message);
        this.clients.delete(spec.name);
      }
    }
    return results;
  }

  /** Errors from the most recent connection/list attempt, keyed by server name. */
  getErrors(): Record<string, string> {
    return Object.fromEntries(this.errors);
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>) {
    const spec = this.specs.find((s) => s.name === server);
    if (!spec) throw new Error(`unknown server "${server}" — not in skilljit's managed upstream list`);
    const client = await this.ensureConnected(server);
    if (!client) {
      throw new Error(
        `upstream "${server}" is not available (${this.errors.get(server) ?? "connection failed"})`,
      );
    }
    try {
      return await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      // A call-time failure might mean the process died; drop the cached
      // client so the next call retries a fresh connection instead of
      // reusing a broken pipe forever.
      this.clients.delete(server);
      this.errors.set(server, (err as Error).message);
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // best-effort on shutdown
      }
      this.clients.delete(name);
    }
  }
}
