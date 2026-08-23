import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit, runAdopt, runRestore, resolveManagedUpstreams, latestAdoption } from "../src/adopt.js";

const ORIGINAL = {
  mcpServers: {
    "postgres-mcp": { command: "npx", args: ["-y", "postgres-mcp"] },
    "keep-me": { command: "npx", args: ["-y", "keep-me-mcp"] },
  },
};

describe("init / adopt / restore lifecycle", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-adopt-"));
    const configPath = path.join(dir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify(ORIGINAL, null, 2));
    const stateDir = path.join(dir, ".skilljit-state");
    return { configPath, stateDir };
  }

  it("init never touches the original file — writes a proposal alongside it", async () => {
    const { configPath, stateDir } = setup();
    const before = fs.readFileSync(configPath, "utf8");

    const result = await runInit({ configPath, stateDir, passthroughServerNames: ["keep-me"] });

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.existsSync(result.proposedPath)).toBe(true);
    expect(result.diff).toContain("- postgres-mcp");
    expect(result.diff).toContain("+ skilljit");
  });

  it("adopt backs up the original, then writes the routed config in place", async () => {
    const { configPath, stateDir } = setup();

    const record = await runAdopt({ configPath, stateDir, passthroughServerNames: ["keep-me"] });

    expect(fs.existsSync(record.backupPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(record.backupPath, "utf8"))).toEqual(ORIGINAL);

    const nowLive = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(nowLive.mcpServers["skilljit"]).toBeDefined();
    expect(nowLive.mcpServers["keep-me"]).toEqual(ORIGINAL.mcpServers["keep-me"]);
    expect(nowLive.mcpServers["postgres-mcp"]).toBeUndefined();
  });

  it("restore puts the config back byte-for-byte equivalent to before adopt", async () => {
    const { configPath, stateDir } = setup();
    const before = fs.readFileSync(configPath, "utf8");

    await runAdopt({ configPath, stateDir, passthroughServerNames: [] });
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(before);

    await runRestore({ configPath, stateDir });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(JSON.parse(before));
  });

  it("restore without a prior adopt throws a clear error instead of corrupting the file", async () => {
    const { configPath, stateDir } = setup();
    await expect(runRestore({ configPath, stateDir })).rejects.toThrow(/no skilljit adoption found/i);
  });

  it("reconstructs the routed upstream specs from the backup after adoption", async () => {
    const { configPath, stateDir } = setup();
    await runAdopt({ configPath, stateDir, passthroughServerNames: ["keep-me"] });

    const record = latestAdoption(stateDir, configPath);
    expect(record).toBeDefined();
    const upstreams = resolveManagedUpstreams(record!);
    expect(upstreams).toEqual([{ name: "postgres-mcp", command: "npx", args: ["-y", "postgres-mcp"] }]);
  });
});
