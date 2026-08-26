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
at startup and dispatch internally via mode/action parameters."* This isn't an
isolated bug either — a broader MCP spec-compliance tracking issue,
[anthropics/claude-code#31893](https://github.com/anthropics/claude-code/issues/31893),
covers `list_changed` alongside other protocol gaps (progress, sampling) together.

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

See [`python/README.md`](python/README.md) for what that package does and doesn't do
— it forwards the CLI to `npx -y skilljit` and adds a read-only `Catalog` for Python.

### Node version support

`skilljit`, `@skilljit/mcp`, and `@skilljit/proxy` require **Node 18+** — that floor
comes directly from `@modelcontextprotocol/sdk`, which the MCP server and proxy layer
depend on and which itself requires 18+. There's no way around this without dropping
MCP support.

`@skilljit/core` (the catalog/search library, no MCP dependency) supports **Node
16+** for anyone using its `Catalog`/`ingestGithubRepo` API directly. On Node 18+ this
is a zero-compile install (`better-sqlite3` ships a prebuilt binary). On Node 16/17,
`better-sqlite3` has no prebuilt binary for that ABI on any platform, so npm falls
back to compiling it from source via `node-gyp` — this needs a C++ toolchain and a
Python with the (pre-3.12) `distutils` module available. That's a standard requirement
for native Node modules, not a skilljit-specific step, but it does mean Node 16/17
installs of `@skilljit/core` aren't guaranteed zero-friction the way 18+ is.

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

Claude Code users can add it via the CLI instead of hand-editing JSON:

```bash
claude mcp add skilljit -- npx -y skilljit serve
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

### How new skills actually get picked up

`sync` is the only thing that writes into the catalog — nothing runs it for you.
`skilljit serve` never syncs on its own; it just reads whatever is currently in
`~/.skilljit/catalog.db`. So a skill someone adds to a repo you track isn't visible
until *something* runs `sync` again — but once it does, it's visible immediately,
even in an already-running session: `skill_find` queries the catalog live on every
call rather than caching it at startup, so there's no need to restart `serve` after a
sync completes.

If you want that closer to automatic, pick one:

```bash
# Cron, e.g. hourly
0 * * * * npx -y skilljit sync >> ~/.skilljit/sync.log 2>&1
```

Or a `post-receive` hook on your skills repo that shells out to `skilljit sync` on
every push, so it's fresh the moment someone merges. skilljit intentionally doesn't
pick this for you — running `sync` by hand before a work session is a perfectly
reasonable default too.

## The six tools

skilljit exposes a fixed surface — it never grows or shrinks at runtime.

| Tool | Returns |
|---|---|
| `skill_find(query, limit=8)` | Cheap candidates: id, source, one-line description, install count, live load count, audit status. |
| `skill_load(name)` | Full SKILL.md body for one skill by id, plus a list of any bundled file paths (not their content). The main point a skill's content enters context. |
| `skill_read_file(name, path)` | One bundled reference doc or helper script's content, by a path `skill_load` listed. |
| `tool_find(query, limit=8)` | Matching upstream MCP tools' full JSON Schema, across every connected server. |
| `tool_call(server, tool, args)` | Generic dispatcher to the matched upstream server and tool. |
| `skilljit_stats()` | Tokens saved this session, **and cumulatively across every skilljit session/tab that's ever used this catalog** — see below. |

`skill_find` → `skill_load` → `skill_read_file` is progressive disclosure rebuilt as
a **pull**, all the way down: the always-loaded cost stops scaling with catalog size,
and a skill's bundled reference docs/scripts stay out of context until named by path,
even after the skill itself has been loaded.

`skill_find`'s ranking isn't pure static text relevance either: every real
`skill_load` call increments a live, cross-session load count for that skill, and
`skill_find` blends it in as a secondary signal — among candidates that already
match the query, ones actually loaded more often in practice rank slightly higher.
It only reorders matches; a skill that didn't match the query can never be
surfaced by popularity alone.

`tool_find` and `tool_call` only appear once you've configured upstream MCP servers
via `skilljit adopt` (see below) — run skills-only and the surface is 4 tools, not 6.
This is what makes the skills half independently shippable and testable from the
proxy half. `incident_find`/`incident_load` are two more opt-in tools on the same
model — see "Incident memory" below.

## Multiple tabs / parallel sessions

Running several Claude Code tabs at once for different tasks is exactly where the
"every tab pays for every installed skill" cost multiplies — N tabs open means that
per-turn overhead is being paid N times simultaneously. skilljit already collapses
that per-tab cost to a fixed few tools regardless of catalog size, but `skilljit_stats()`
goes further: every session's baseline/actual numbers are also written into the shared
`catalog.db` (the same file every tab's `skilljit serve` process already points at), so
the reported totals are cumulative across **every tab you've had open**, not just the
one you're asking from. Losing a tab doesn't lose that number — it was already durably
written, not held only in that tab's memory.

This does **not** recover a lost tab's conversation itself — that's a Claude Code
session feature (`claude --resume` / `--continue`), unrelated to skilljit. What it
fixes specifically is the token-accounting blind spot: "how much has skilljit actually
saved me today, across everything I had open," surviving any one tab dying.

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

**Relationship to Claude Code's native Tool Search:** Anthropic shipped a built-in MCP
tool search (`defer_loading: true`) that does something similar for servers whose
authors opt into it. skilljit's proxy works today, unconditionally, on any existing
MCP server — no cooperation from the server's author required, and no waiting for
them to adopt anything. That's the actual gap skilljit fills.

**Heads up if you `--keep` many servers:** Claude enforces a 256-tool cap across all
connected MCP connectors, with silent truncation past that (alphabetically-first
tools kept). skilljit's own fixed surface is nowhere near this, but a large `--keep`
list leaves those servers' tools fully passthrough-visible, so it's worth keeping in
mind if you lean on `--keep` heavily.

## Incident memory — sharing debugging context across a team

When you fix a bug, the diff shows *what* changed but not *why* — the symptom you
started from, what you ruled out, and how you found the root cause. That context
normally dies with your terminal history. Incident memory captures it automatically
and shares it through the same sync path skills already use, so a teammate who hits
the same symptom later gets your investigation, not just your commit.

Setup, one time per machine:

```bash
# 1. Point skilljit at a git repo to capture incidents into (and later sync from)
skilljit incidents init git@github.com:your-org/incidents.git

# 2. Install the hook that captures on fix-like commits — dry run by default
skilljit incidents install-hook
skilljit incidents install-hook --yes
```

From then on, whenever a Claude Code session runs a `git commit` whose message looks
like a fix (`fix: ...`, `fixes #123`, `closes #45`, `resolves #77`, including the
heredoc-wrapped commit format Claude Code itself uses), the hook:

1. Reads that session's transcript and the commit's diff.
2. Asks `claude -p` to synthesize a paraphrased symptom / investigation / root cause /
   fix — never raw log lines or literal values, by instruction and then by a
   mechanical redaction pass over the result.
3. Fails closed on anything that doesn't check out (bad JSON shape, a redaction
   concern, the commit not actually having landed) — nothing gets written or pushed
   unless the whole pipeline succeeds.
4. Commits and pushes the result to the incidents repo from step 1.

Everyone who runs `skilljit sync` afterward picks up new incidents the same way they
already pick up new skills — no separate command.

Two more opt-in MCP tools appear automatically in `skilljit serve` once
`skilljit incidents init` has been run — no extra flag needed:

| Tool | Returns |
|---|---|
| `incident_find(symptom, limit=8)` | Cheap candidates: id, symptom, root cause, repo, capture time, verified status — without the full investigation/fix. |
| `incident_load(id)` | The full symptom/investigation/root-cause/fix, plus the commit and repo it's about, for one incident by id. Warns loudly if the incident hasn't been human-verified yet. |

Every auto-captured incident starts `verified: false` and says so loudly in
`incident_load`'s output — the same unaudited-source posture as skills (see
Security, below). Nothing here pushes context at anyone proactively: a teammate
only sees an incident when they call `incident_find` themselves.

If a captured incident turns out wrong, or leaked something it shouldn't have,
retract it:

```bash
skilljit incidents revoke <id> --reason "misdiagnosed root cause"
```

This marks the record revoked and pushes the change — it isn't deleted, since
there's no mechanism to detect a deleted file and drop the matching row on
`sync`. Once a teammate's next `sync` picks it up, `incident_find` stops
surfacing it and `incident_load` refuses to return its content, reporting the
revocation and reason instead. Anyone with push access to the incidents repo
can revoke — same trust boundary as capture itself, no separate auth system.

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

`bench/` ships a labeled set of 41 `(task → correct skill)` pairs and a recall@k
harness, so "the search works" is a measured claim rather than a vibe. Current
numbers, reproducible with `node bench/run.mjs`:

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
recall is genuinely inadequate — the three misses above (all near-misses, correct
skill just outside top 3) are the concrete candidates for that decision.

## Publishing

Pushing a `v*` tag (e.g. `v0.1.2`) runs CI, then publishes every package to npm and
PyPI via Trusted Publishing (OIDC) — no long-lived `NPM_TOKEN`/`PYPI_TOKEN` secrets in
this repo. See [`.github/workflows/release.yml`](.github/workflows/release.yml).

One-time setup required before that works, done manually (cannot be automated):

- On **npmjs.com**, register a Trusted Publisher for each of `@skilljit/core`,
  `@skilljit/proxy`, `@skilljit/mcp`, and `skilljit`, pointing at this repo, the
  `release.yml` workflow file, and the `npm` environment.
- On **pypi.org**, register a Trusted Publisher for the `skilljit` project, pointing
  at this repo, the `release.yml` workflow file, and the `pypi` environment.

## Architecture

```
skilljit/
  packages/core/     catalog store, FTS5 index, ranking, token accounting
  packages/proxy/    upstream MCP server management, config adopt/restore, tool_find/tool_call routing
  packages/mcp/      the MCP stdio server (the fixed tool surface, see "The six tools" above)
  packages/cli/      skilljit sync | search | serve | stats | init | adopt | restore | doctor |
                     incidents init | incidents install-hook | incidents revoke
  python/            pip package — CLI shim + read-only query API for Agent SDK users
  bench/             labeled task→skill eval set + recall@k harness
```

TypeScript is the single implementation; the PyPI package is a thin, honest wrapper
around it rather than a second implementation of the ranking logic.

## License

MIT
