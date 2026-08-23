# skilljit (Python)

Just-in-time skill and MCP tool routing for Claude — install thousands of
skills at the token cost of one.

This package is a thin companion to the [npm `skilljit` package](https://www.npmjs.com/package/skilljit),
which is where the CLI, MCP server, catalog sync, and MCP-proxy adoption
logic actually live (the MCP ecosystem is npx-first). What you get here:

- **`skilljit` command** — forwards to `npx -y skilljit` (requires Node.js).
- **`from skilljit import Catalog`** — read-only, dependency-free (stdlib
  `sqlite3` only) queries against the same `~/.skilljit/catalog.db` the
  Node CLI syncs, for `claude-agent-sdk` users who want to inject skills
  into their own agent loop instead of going through MCP.

```python
from skilljit import Catalog

with Catalog() as catalog:
    for hit in catalog.search_skills("postgres migration", limit=3):
        print(hit.skill.name, hit.skill.source)

    skill = catalog.get_skill("acme/repo/postgres-migrate")
    for f in skill.files or []:  # bundled reference docs/scripts, if any
        print(f.path)
```

See the [main repo](https://github.com/aqibsidd/skilljit) for the full
design, the token-savings numbers, and how to set up MCP tool routing.

MIT licensed.
