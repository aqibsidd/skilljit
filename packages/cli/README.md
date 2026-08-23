# skilljit

Just-in-time skill and MCP tool routing for Claude — install thousands of skills at
the token cost of one. Nothing loads into context until a task actually needs it.

## Why the tool list never changes

The obvious way to add tools on demand is the MCP `notifications/tools/list_changed`
notification. It's broken in Claude Desktop —
[anthropics/claude-code#50339](https://github.com/anthropics/claude-code/issues/50339)
documents it being ignored across 336+ versions (empty client capabilities, an SDK
handler that never fires, a frozen tool-list reference) and Anthropic closed the issue
as **not planned**. The issue's own recommended workaround is to *"declare all tools
at startup and dispatch internally via mode/action parameters."*

That's what skilljit does. Its MCP tool list is **fixed and never changes** — a
small, constant handful of tools, always. Skills and upstream MCP tools are found
and loaded through those tools, not by re-registering the tool list. This is why skilljit works on Claude
Desktop, Claude Code, Codex, and Cursor while `list_changed`-based proxies silently
degrade on at least one of them.

## The problem

Claude's Agent Skills use progressive disclosure: each skill's `name` + `description`
(~100 tokens) sits in the system prompt on every turn, and only the body loads on
demand. That works at 10 skills. It collapses at scale — the ecosystem is already
there, with tens of thousands of skills across thousands of repos. Installing 200 of
them costs tens of thousands of tokens *per turn*, forever. So nobody does — everyone
installs ten and the rest are unreachable.

MCP has the identical problem, worse: every connected server's full tool schemas load
at startup, commonly 20–50k tokens before the user types anything.

| | Without skilljit | With skilljit |
|---|---|---|
| Skills reachable | ~10 | tens of thousands |
| Per-turn skill overhead | 1k–20k tokens, grows forever | ~flat |
| Per-turn MCP tool overhead | 20k–50k tokens | ~flat |

## Install

```bash
npx -y skilljit sync
```

That's the primary path — the MCP ecosystem is npx-first, and Claude Code / Desktop
configs already expect this shape.

A thin Python companion is also published for
[`claude-agent-sdk`](https://pypi.org/project/skilljit/) users who want to query the
same catalog directly instead of going through MCP:

```bash
pip install skilljit
```

See [`python/README.md`](https://github.com/aqibsidd/skilljit/blob/main/python/README.md)
for what that package does and doesn't do — it forwards the CLI to `npx -y skilljit`
and adds a read-only `Catalog` for Python.

## Quickstart

```bash
# 1. Build the local catalog from GitHub sources (SQLite, ~/.skilljit/catalog.db)
skilljit sync

# 2. Search it — no network call, no context cost
skilljit search "postgres migration"

# 3. Point your MCP client at the server
skilljit serve
```

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "skilljit": {
      "command": "npx",
      "args": ["-y", "skilljit", "serve"]
    }
  }
}
```

Other commands: `skilljit stats` (catalog size + how to read live savings),
`skilljit init <configPath>` (preview routing your existing MCP servers through
skilljit — never mutates the original), `skilljit adopt <configPath>` (apply it),
`skilljit doctor [configPath]` (verify upstreams still work), `skilljit restore
<configPath>` (undo `adopt`).

## Adding your own skills to `sync`

By default `sync` only pulls from a small curated list of public repos. To add your
own:

```bash
# Another public (or your-token-authenticated private) GitHub repo:
skilljit sync --repo your-org/internal-skills --token "$SKILLJIT_GITHUB_TOKEN"

# Any git remote at all — self-hosted, GitLab, Bitbucket, or a private repo
# reached over SSH — using whatever git credentials are already set up on
# this machine. No GitHub API token needed for this path.
skilljit sync --git git@git.internal.example.com:team/skills.git
```

Both flags are repeatable. `--git` sources are ingested via a bare mirror clone plus
`git worktree` rather than the GitHub API: the first sync pays for a full clone, every
sync after that is a cheap `git fetch` + worktree checkout — no rate limit, no token,
works against anything `git` itself can reach.

## The six tools

skilljit exposes a fixed surface — it never grows or shrinks at runtime.

| Tool | Returns |
|---|---|
| `skill_find(query, limit=8)` | Cheap candidates: id, source, one-line description, install count, audit status. |
| `skill_load(name)` | Full SKILL.md body for one skill by id, plus a list of any bundled file paths (not their content). The main point a skill's content enters context. |
| `skill_read_file(name, path)` | One bundled reference doc or helper script's content, by a path `skill_load` listed. |
| `tool_find(query, limit=8)` | Matching upstream MCP tools' full JSON Schema, across every connected server. |
| `tool_call(server, tool, args)` | Generic dispatcher to the matched upstream server and tool. |
| `skilljit_stats()` | Tokens saved this session, and cumulatively across every skilljit session/tab that's ever used this catalog — see below. |

`skill_find` → `skill_load` → `skill_read_file` is progressive disclosure rebuilt as
a **pull**, all the way down: the always-loaded cost stops scaling with catalog size,
and a skill's bundled reference docs/scripts stay out of context until named by path,
even after the skill itself has been loaded.

`tool_find` and `tool_call` only appear once you've configured upstream MCP servers
via `skilljit adopt` (see below) — run skills-only and the surface is 4 tools, not 6.
This is what makes the skills half independently shippable and testable from the
proxy half.

## Multiple tabs / parallel sessions

Running several Claude Code tabs at once for different tasks is exactly where the
"every tab pays for every installed skill" cost multiplies — N tabs open means that
per-turn overhead is being paid N times simultaneously. skilljit already collapses
that per-tab cost to a fixed few tools regardless of catalog size, but `skilljit_stats()`
goes further: every session's baseline/actual numbers are also written into the shared
`catalog.db` (the same file every tab's `skilljit serve` process already points at), so
the reported totals are cumulative across every tab you've had open, not just the one
you're asking from — and losing a tab doesn't lose that number, since it was already
durably written, not held only in that tab's memory. This does not recover a lost tab's
conversation itself — that's a Claude Code session feature (`claude --resume`), unrelated
to skilljit.

## MCP proxy — routing your other MCP servers

Passing `skilljit serve --config <path>` (the config path you previously ran
`skilljit adopt` on) turns on `tool_find`/`tool_call` for the servers it adopted.
Safety comes first here, since this touches configs you already rely on:

- **`skilljit init <configPath>`** never mutates the original file — it writes a
  proposed config and prints a diff.
- **`skilljit adopt <configPath>`** is a dry run by default; pass `--yes` to actually
  write the change, after backing up the original.
- **`--keep server1,server2`** leaves those servers untouched — fully visible in the
  static tool list, no `tool_find` round-trip. Useful for hot-path tools you call on
  every turn. (Keep is per-server, not per-tool, in this version.)
- **`skilljit doctor [configPath]`** verifies every adopted upstream still spawns,
  handshakes, and lists tools.
- **`skilljit restore <configPath>`** is one command that puts the original config
  back.
- One upstream MCP server being unavailable doesn't affect the others: `tool_call`
  returns a clean error for that server, everything else keeps working.

## Security

Skills are, functionally, instructions from a stranger that an agent will follow —
Anthropic warns explicitly that a malicious skill can exfiltrate data or misuse tools.
skilljit treats that as a feature to design for, not an afterthought:

- Every `skill_find` result surfaces the skill's audit status alongside its
  description.
- `skill_load` warns loudly in the returned content when a skill failed its audit, or
  hasn't been audited at all — the same posture as installing software from an
  unknown source.

## Benchmark

The repo ships a labeled set of 41 `(task → correct skill)` pairs and a recall@k
harness, so "the search works" is a measured claim rather than a vibe. Current
numbers, reproducible with
[`node bench/run.mjs`](https://github.com/aqibsidd/skilljit/blob/main/bench/run.mjs):

```
skilljit bench — 41 queries over 41 skills

recall@1: 37/41  (90.2%)
recall@3: 38/41  (92.7%)
recall@8: 41/41  (100.0%)
```

Search is SQLite FTS5 + BM25 — no embeddings in v1. That's a deliberate YAGNI call:
FTS5 ships identically in both the Node (`better-sqlite3`) and Python (stdlib)
implementations, with no model download or extra runtime deps. The residual recall
risk (skill descriptions are semantic — "use when the user mentions PDFs…") is
mitigated structurally: `skill_find` returns several candidates for Claude to
consider and re-query on, rather than committing to a one-shot top-1 result.
Embeddings stay an opt-in option, to be added only if this benchmark shows FTS5
recall is genuinely inadequate.

## Architecture

```
skilljit/
  packages/core/     catalog store, FTS5 index, ranking, token accounting
  packages/proxy/    upstream MCP server management, config adopt/restore, tool_find/tool_call routing
  packages/mcp/      the MCP stdio server (the fixed tool surface, see "The six tools" above)
  packages/cli/      skilljit sync | search | serve | stats | init | adopt | restore | doctor  (this package)
  python/            pip package — CLI shim + read-only query API for Agent SDK users
  bench/             labeled task→skill eval set + recall@k harness
```

See the [main repo](https://github.com/aqibsidd/skilljit) for the full source,
issue tracker, and publishing setup.

## License

MIT
