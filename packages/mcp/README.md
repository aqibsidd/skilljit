# @skilljit/mcp

The MCP stdio server at the core of [skilljit](https://github.com/aqibsidd/skilljit)
— a fixed 5-tool surface (`skill_find`, `skill_load`, `tool_find`, `tool_call`,
`skilljit_stats`) that never grows or shrinks at runtime, so nothing depends on
MCP's broken `notifications/tools/list_changed`.

Most people should install [`skilljit`](https://www.npmjs.com/package/skilljit)
(the CLI) rather than this package directly — it wires this server up via
`skilljit serve` with the right catalog path and, optionally, adopted upstreams.
This package is published standalone for anyone embedding the server in their own
Node process instead of spawning the CLI.

```ts
import { createServer } from "@skilljit/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { server } = createServer({ catalogPath: "~/.skilljit/catalog.db" });
await server.connect(new StdioServerTransport());
```

See the [main repo](https://github.com/aqibsidd/skilljit) for the full design and
why the tool list is fixed.

MIT licensed.
