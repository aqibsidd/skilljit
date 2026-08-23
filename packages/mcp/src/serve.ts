#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultCatalogPath } from "@skilljit/core";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const catalogPath = process.env.SKILLJIT_CATALOG_PATH ?? defaultCatalogPath();
  const { server } = createServer({ catalogPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("skilljit-mcp failed to start:", err);
  process.exit(1);
});
