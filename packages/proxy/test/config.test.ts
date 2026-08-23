import { describe, it, expect } from "vitest";
import { proposeConfig, diffConfigs } from "../src/config.js";
import type { McpClientConfig } from "../src/config.js";

describe("proposeConfig", () => {
  const original: McpClientConfig = {
    mcpServers: {
      "postgres-mcp": { command: "npx", args: ["-y", "postgres-mcp"] },
      "github-mcp": { command: "npx", args: ["-y", "github-mcp"] },
      "keep-me": { command: "npx", args: ["-y", "keep-me-mcp"] },
    },
  };

  it("replaces routed servers with a single skilljit entry, keeps passthrough servers untouched", () => {
    const proposed = proposeConfig(original, {
      skilljitCommand: "npx",
      skilljitArgs: ["-y", "skilljit", "serve"],
      passthroughServerNames: ["keep-me"],
    });

    expect(proposed.config.mcpServers["skilljit"]).toEqual({ command: "npx", args: ["-y", "skilljit", "serve"] });
    expect(proposed.config.mcpServers["keep-me"]).toEqual(original.mcpServers["keep-me"]);
    expect(proposed.config.mcpServers["postgres-mcp"]).toBeUndefined();
    expect(proposed.config.mcpServers["github-mcp"]).toBeUndefined();
  });

  it("never mutates the original config object", () => {
    const before = JSON.stringify(original);
    proposeConfig(original, { skilljitCommand: "npx", skilljitArgs: [], passthroughServerNames: [] });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("computes the list of servers that would be routed (moved under skilljit)", () => {
    const proposed = proposeConfig(original, {
      skilljitCommand: "npx",
      skilljitArgs: ["-y", "skilljit", "serve"],
      passthroughServerNames: ["keep-me"],
    });
    expect(proposed.routedServerNames.sort()).toEqual(["github-mcp", "postgres-mcp"]);
  });
});

describe("diffConfigs", () => {
  it("produces a human-readable summary of what would change", () => {
    const original: McpClientConfig = {
      mcpServers: { a: { command: "x" }, b: { command: "y" } },
    };
    const proposed = proposeConfig(original, {
      skilljitCommand: "npx",
      skilljitArgs: ["-y", "skilljit", "serve"],
      passthroughServerNames: ["b"],
    });
    const diff = diffConfigs(original, proposed.config);
    expect(diff).toContain("- a");
    expect(diff).toContain("+ skilljit");
    expect(diff).not.toContain("- b");
  });
});
