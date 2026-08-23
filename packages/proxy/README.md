# @skilljit/proxy

Upstream MCP server management for [skilljit](https://github.com/aqibsidd/skilljit)
— adopting/restoring a client's MCP config, and the `tool_find`/`tool_call` routing
layer that lets an MCP server search other servers' tools without their schemas
sitting in the static tool list.

Most people want the [`skilljit`](https://www.npmjs.com/package/skilljit) CLI
(`skilljit init` / `adopt` / `doctor` / `restore`), not this package directly. It's
published standalone because [`@skilljit/mcp`](https://www.npmjs.com/package/@skilljit/mcp)
depends on it and because it's independently useful if you're building your own MCP
proxy.

See the [main repo](https://github.com/aqibsidd/skilljit) for the full design,
including the safety model behind `adopt`/`restore` and why `tool_find`/`tool_call`
exist instead of MCP's broken `notifications/tools/list_changed`.

MIT licensed.
