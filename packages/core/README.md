# @skilljit/core

Local SQLite catalog, FTS5 full-text search, and token accounting for
[skilljit](https://github.com/aqibsidd/skilljit) — just-in-time skill and MCP
tool routing for Claude.

Most people want the [`skilljit`](https://www.npmjs.com/package/skilljit) CLI, not
this package directly. This is the internal storage/search/ranking layer it's built
on, published standalone in case you want to build your own tooling against the same
`~/.skilljit/catalog.db`.

```ts
import { Catalog } from "@skilljit/core";

const catalog = new Catalog("~/.skilljit/catalog.db");
const hits = catalog.searchSkills("postgres migration", 3);
```

Also exports `ingestGithubRepo` (GitHub API ingestion) and `ingestLocalGitRepo`
(clone + `git worktree` ingestion for any git remote — self-hosted, GitLab, an
SSH-authenticated private repo), plus a persistent cross-session token ledger on
`Catalog` so `skilljit_stats()` can report totals across every tab sharing a catalog.

**Node 16+.** On Node 18+ this is a zero-compile install (`better-sqlite3` ships a
prebuilt binary). On Node 16/17 there's no prebuilt binary for that ABI on any
platform, so npm compiles it from source via `node-gyp` — needs a C++ toolchain and
a Python with `distutils` available (removed in Python 3.12+).

See the [main repo](https://github.com/aqibsidd/skilljit) for the full design,
the fixed tool surface, and benchmark numbers.

MIT licensed.
