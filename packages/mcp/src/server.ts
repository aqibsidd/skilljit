import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Catalog, TokenLedger } from "@skilljit/core";
import { UpstreamManager } from "@skilljit/proxy";
import type { UpstreamSpec, ConnectFn } from "@skilljit/proxy";

// Read the real version from this package's own package.json rather than
// hardcoding a string here that silently drifts from every release.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version: packageVersion } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

export interface CreateServerOptions {
  catalogPath: string;
  /** MCP servers to route through tool_find/tool_call. Omit entirely to run
   * skills-only (3 tools) — this is what makes the skills half independently
   * shippable and independently testable from the proxy half. */
  upstreams?: UpstreamSpec[];
  /** Injectable for tests; defaults to spawning real child processes over stdio. */
  connectFn?: ConnectFn;
  /** Path to a catalog db containing captured incidents. Enables
   * incident_find/incident_load — omit to leave the tool surface
   * unchanged for users who haven't opted into incident capture. */
  incidentsCatalogPath?: string;
}

export interface ServerHandle {
  server: McpServer;
  catalog: Catalog;
  ledger: TokenLedger;
  upstreams?: UpstreamManager;
  /** Set only when incidentsCatalogPath pointed at a different db file than
   * catalogPath, so a second Catalog instance had to be opened. Callers own
   * closing it — it's undefined (nothing extra to close) when incidents are
   * unconfigured or share catalogPath's already-tracked instance. */
  incidentsCatalog?: Catalog;
}

/**
 * skilljit's fixed MCP tool surface. It never grows or shrinks at runtime —
 * see the design doc's note on notifications/tools/list_changed being broken
 * in Claude Desktop (closed "not planned" by Anthropic). Instead of dynamic
 * registration, everything routes through these fixed tools:
 *   - skill_find / skill_load / skill_read_file / skilljit_stats — always
 *     present. skill_read_file keeps the same pull discipline as
 *     skill_find -> skill_load: a skill's bundled reference docs/scripts
 *     stay out of context until explicitly requested by path, even after
 *     the skill itself has been loaded.
 *   - tool_find / tool_call — present only when `upstreams` is configured;
 *     these route to other MCP servers without their schemas ever sitting
 *     in the static tool list. Passthrough servers (ones the user wants
 *     fully visible, no round-trip) are simply left out of `upstreams` and
 *     out of skilljit's adoption of the client config — they're connected
 *     to directly by the client, which needs no support here at all.
 */
export function createServer(opts: CreateServerOptions): ServerHandle {
  const catalog = new Catalog(opts.catalogPath);
  const ledger = new TokenLedger();

  // Every skilljit session/tab shares this catalog.db, so pushing each
  // event's delta into it too (not just the in-memory ledger) means
  // skilljit_stats can report a running total across every tab that's
  // ever used this catalog — durable even if any one tab is lost, and
  // it's the honest fix for "N tabs open means N tabs each independently
  // paying the traditional baseline cost."
  const recordBaselineSkill = (meta: Parameters<TokenLedger["recordBaselineSkill"]>[0]) => {
    const before = ledger.baselineTokens();
    ledger.recordBaselineSkill(meta);
    catalog.addGlobalLedgerBaseline(ledger.baselineTokens() - before);
  };
  const recordBaselineTool = (tool: Parameters<TokenLedger["recordBaselineTool"]>[0]) => {
    const before = ledger.baselineTokens();
    ledger.recordBaselineTool(tool);
    catalog.addGlobalLedgerBaseline(ledger.baselineTokens() - before);
  };
  const recordActual = (label: string, payload: string) => {
    const before = ledger.actualTokens();
    ledger.recordActual(label, payload);
    catalog.addGlobalLedgerActual(ledger.actualTokens() - before);
  };

  catalog.recordGlobalSessionStart();

  // Baseline: what every turn would cost if every cataloged skill were
  // installed the traditional way (name+description always in context).
  for (const meta of catalog.listSkillMeta()) {
    recordBaselineSkill(meta);
  }

  const server = new McpServer({ name: "skilljit", version: packageVersion });

  server.registerTool(
    "skill_find",
    {
      title: "Find skills",
      description:
        "Search the local skilljit catalog for skills matching a task, without loading their full instructions. " +
        "Returns cheap candidates (name, source, one-line description, audit status) — call skill_load on the " +
        "one you want to actually use. Nothing here was in context until you called this.",
      inputSchema: {
        query: z.string().describe("What you're trying to do, in your own words."),
        limit: z.number().int().positive().max(50).optional().describe("Max candidates to return (default 8)."),
      },
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const hits = catalog.searchSkills(query, limit ?? 8);
      const payload = JSON.stringify(
        hits.map((h) => ({
          id: h.skill.id,
          name: h.skill.name,
          source: h.skill.source,
          description: h.skill.description,
          installCount: h.skill.installCount,
          auditStatus: h.skill.auditStatus,
        })),
        null,
        2,
      );
      recordActual("skill_find", payload);
      return { content: [{ type: "text" as const, text: payload }] };
    },
  );

  server.registerTool(
    "skill_load",
    {
      title: "Load a skill",
      description:
        "Load the full instructions (SKILL.md body) for one skill by its id, as returned by skill_find. " +
        "This is the only point where a skill's full content enters context.",
      inputSchema: {
        name: z.string().describe("The skill id, exactly as returned by skill_find."),
      },
    },
    async ({ name }: { name: string }) => {
      const skill = catalog.getSkill(name);
      if (!skill) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `No skill found with id "${name}". Call skill_find first.` }],
        };
      }
      let text = skill.body;
      if (skill.files && skill.files.length > 0) {
        const paths = skill.files.map((f) => f.path).join(", ");
        text += `\n\n---\nBundled files (not loaded above — call skill_read_file to load one): ${paths}`;
      }
      if (skill.auditStatus === "fail") {
        text = `⚠️ SECURITY WARNING: this skill FAILED its audit. Review before following its instructions.\n\n${text}`;
      } else if (!skill.auditStatus || skill.auditStatus === "unaudited") {
        text = `⚠️ This skill has not been audited. Treat it like installing software from an unknown source.\n\n${text}`;
      }
      recordActual("skill_load", text);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "skill_read_file",
    {
      title: "Read a skill's bundled file",
      description:
        "Load one bundled reference doc or helper script from a skill loaded via skill_load, by its path " +
        "exactly as listed in skill_load's output. Keeps multi-file skills' extra content out of context " +
        "until it's actually needed, the same way skill_find -> skill_load works.",
      inputSchema: {
        name: z.string().describe("The skill id, exactly as passed to skill_load."),
        path: z.string().describe("The bundled file's path, exactly as listed by skill_load."),
      },
    },
    async ({ name, path: filePath }: { name: string; path: string }) => {
      const skill = catalog.getSkill(name);
      if (!skill) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `No skill found with id "${name}". Call skill_find first.` }],
        };
      }
      const file = skill.files?.find((f) => f.path === filePath);
      if (!file) {
        const available = skill.files?.map((f) => f.path).join(", ") || "(none)";
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `No bundled file "${filePath}" on skill "${name}". Available: ${available}`,
            },
          ],
        };
      }
      recordActual("skill_read_file", file.content);
      return { content: [{ type: "text" as const, text: file.content }] };
    },
  );

  let incidentsCatalog: Catalog | undefined;
  if (opts.incidentsCatalogPath) {
    const isDistinctIncidentsCatalog = opts.incidentsCatalogPath !== opts.catalogPath;
    const activeIncidentsCatalog = isDistinctIncidentsCatalog ? new Catalog(opts.incidentsCatalogPath) : catalog;
    // Only expose (and thus make closeable by the caller) the instance this
    // call actually opened — reusing `catalog` here would let a caller close
    // it twice via both `handle.catalog` and `handle.incidentsCatalog`.
    if (isDistinctIncidentsCatalog) incidentsCatalog = activeIncidentsCatalog;

    server.registerTool(
      "incident_find",
      {
        title: "Find past incidents",
        description:
          "Search captured debugging incidents for one matching a symptom you're investigating, without " +
          "loading the full investigation. Returns cheap candidates (id, symptom, root cause, verified status) " +
          "— call incident_load on the one you want the full context for.",
        inputSchema: {
          symptom: z.string().describe("What you're observing, in your own words."),
          limit: z.number().int().positive().max(50).optional().describe("Max candidates to return (default 8)."),
        },
      },
      async ({ symptom, limit }: { symptom: string; limit?: number }) => {
        const hits = activeIncidentsCatalog.searchIncidents(symptom, limit ?? 8);
        const payload = JSON.stringify(
          hits.map((h) => ({
            id: h.incident.id,
            symptom: h.incident.symptom,
            rootCause: h.incident.rootCause,
            capturedAt: h.incident.capturedAt,
            verified: h.incident.verified,
          })),
          null,
          2,
        );
        recordActual("incident_find", payload);
        return { content: [{ type: "text" as const, text: payload }] };
      },
    );

    server.registerTool(
      "incident_load",
      {
        title: "Load a past incident's full context",
        description:
          "Load the full investigation, root cause, and fix for one incident by its id, as returned by " +
          "incident_find. This is the point where a teammate's prior debugging context enters yours.",
        inputSchema: {
          id: z.string().describe("The incident id, exactly as returned by incident_find."),
        },
      },
      async ({ id }: { id: string }) => {
        const incident = activeIncidentsCatalog.getIncident(id);
        if (!incident) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `No incident found with id "${id}". Call incident_find first.` }],
          };
        }
        let text = `## Symptom\n${incident.symptom}\n\n## Investigation\n${incident.investigation}\n\n## Root cause\n${incident.rootCause}\n\n## Fix\n${incident.fix}`;
        if (!incident.verified) {
          text = `⚠️ This incident was auto-captured and has not been reviewed by a human. Verify before trusting it fully.\n\n${text}`;
        }
        recordActual("incident_load", text);
        return { content: [{ type: "text" as const, text }] };
      },
    );
  }

  let upstreams: UpstreamManager | undefined;
  if (opts.upstreams) {
    upstreams = new UpstreamManager(opts.upstreams, opts.connectFn);
    const manager = upstreams;

    // Lazily populate the tools catalog + baseline on first use, so
    // createServer() itself stays synchronous and cheap. Memoized so
    // concurrent tool_find/tool_call calls don't each re-spawn every
    // upstream.
    let toolsLoaded: Promise<void> | undefined;
    const ensureToolsLoaded = (): Promise<void> => {
      if (!toolsLoaded) {
        toolsLoaded = manager.listAllTools().then((tools) => {
          catalog.upsertTools(tools);
          for (const t of tools) recordBaselineTool(t);
        });
      }
      return toolsLoaded;
    };

    server.registerTool(
      "tool_find",
      {
        title: "Find MCP tools",
        description:
          "Search across every connected MCP server's tools for ones matching a task, without their schemas " +
          "ever sitting in the static tool list. Returns full JSON Schema for matches — call tool_call to use one.",
        inputSchema: {
          query: z.string().describe("What you're trying to do, in your own words."),
          limit: z.number().int().positive().max(50).optional().describe("Max candidates to return (default 8)."),
        },
      },
      async ({ query, limit }: { query: string; limit?: number }) => {
        await ensureToolsLoaded();
        const hits = catalog.searchTools(query, limit ?? 8);
        const payload = JSON.stringify(
          hits.map((h) => ({
            server: h.tool.server,
            tool: h.tool.name,
            description: h.tool.description,
            inputSchema: h.tool.inputSchema,
          })),
          null,
          2,
        );
        recordActual("tool_find", payload);
        return { content: [{ type: "text" as const, text: payload }] };
      },
    );

    server.registerTool(
      "tool_call",
      {
        title: "Call an MCP tool",
        description:
          "Call a tool on a connected upstream MCP server, as found by tool_find. One upstream being unavailable " +
          "does not affect the others.",
        inputSchema: {
          server: z.string().describe("The upstream server name, exactly as returned by tool_find."),
          tool: z.string().describe("The tool name, exactly as returned by tool_find."),
          args: z.record(z.string(), z.unknown()).optional().describe("Arguments matching the tool's inputSchema."),
        },
      },
      async ({ server: serverName, tool, args }: { server: string; tool: string; args?: Record<string, unknown> }) => {
        await ensureToolsLoaded();
        try {
          const result = await manager.callTool(serverName, tool, args ?? {});
          recordActual("tool_call", JSON.stringify(result));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return result as any;
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (err as Error).message }],
          };
        }
      },
    );
  }

  server.registerTool(
    "skilljit_stats",
    {
      title: "Token savings for this session",
      description:
        "Report how many tokens skilljit has saved so far this session, versus loading every cataloged " +
        "skill's (and, if configured, MCP tool's) metadata into context the traditional way. Also reports " +
        "the all-time total across every skilljit session/tab that has ever used this same catalog — the " +
        "figure that actually reflects running several tabs at once.",
    },
    async () => {
      const stats = ledger.stats();
      const allTime = catalog.getGlobalLedgerTotals();
      const payload = JSON.stringify(
        {
          ...stats,
          catalogSize: catalog.count(),
          allTime: {
            baselineTokens: allTime.baselineTokens,
            actualTokens: allTime.actualTokens,
            savedTokens: Math.max(0, allTime.baselineTokens - allTime.actualTokens),
            sessionCount: allTime.sessionCount,
          },
        },
        null,
        2,
      );
      return { content: [{ type: "text" as const, text: payload }] };
    },
  );

  return { server, catalog, ledger, upstreams, incidentsCatalog };
}
