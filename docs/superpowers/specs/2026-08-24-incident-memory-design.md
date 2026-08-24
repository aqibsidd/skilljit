# Incident memory: cross-team debugging context for skilljit

## Context

The motivating scenario: a developer fixes a production bug, pushes the fix, and
some time later a teammate hits the same class of problem. Today they get the code
diff (via git) but not the *context* — what was tried, what was ruled out, why the
fix works. That context either gets re-derived from scratch or relayed informally
(Slack, a hallway conversation) and is usually lost.

### Why this, and why now

Before designing anything, we researched whether this is already solved. It isn't,
but it also isn't untouched ground — the picture is more specific than either
extreme:

- **Anthropic has not shipped this.** [anthropics/claude-code#38536,
  "Feature Request: Shared Team Memory for Claude Code"](https://github.com/anthropics/claude-code/issues/38536)
  has been open since March 2026 with 26 comments describing this exact pain point.
  Third-party blog claims of an official "team memory sync" feature do not hold up
  against Anthropic's own docs or that issue's open status — what's actually shipped
  is `CLAUDE.md` (manual, git-committed static instructions) and "auto memory"
  (corrections/preferences, but stored per-user only, never synced to teammates).
  "Channels" (research preview) pushes external events into a running session but
  isn't built for this.
- **The issue thread already spawned several point-solutions** — NEXO Brain
  (open-source MCP memory server), `claude-handoff` (git-based session
  export/import), a "teamem" plugin proof-of-concept, Context Cloud (a startup
  product whose repo link already 404s, i.e. early/fragile). All fragmented, none
  dominant.
- **The specific gap**: every solution found is *passive pull* ("ask Claude what we
  know about X") or *manual export* (someone proactively exports their session).
  None automatically detect "this looks like a bug someone already solved" and
  surface the prior investigation unprompted, matched by symptom. That's the gap
  this design targets, and it maps directly onto skilljit's existing
  catalog-and-fixed-tool mechanism — just applied to a new content type.
- **Named risk**: Anthropic is visibly investing in this space (Channels; two more
  open issues, #27702 and #60082, requesting live session sharing/collaboration).
  This design should be read as "worth building now," not "safe from being
  subsumed later" — see Non-goals.

## Data model

A new record type, `IncidentRecord`, parallel to the existing `SkillRecord`:

```ts
interface IncidentRecord {
  id: string;              // e.g. "git:<repo>/incidents/<short-sha>"
  symptom: string;          // what was observed — the field incident_find searches
  investigation: string;    // what was tried, what got ruled out
  rootCause: string;
  fix: string;              // what changed, references the commit
  commitSha: string;
  repo: string;
  filesTouched?: string[];
  capturedAt: string;
  verified: boolean;        // false until a human confirms it — see Safety & governance
}
```

Stored as Markdown files with YAML frontmatter — `symptom`/`rootCause`/`commitSha`/
etc. as frontmatter, `investigation` and `fix` as body sections — one file per
incident (e.g. `incidents/2026-08-24-a1b2c3.md`). This deliberately mirrors the
`SKILL.md` convention so the existing frontmatter-parsing and git-ingestion code
(`parseSkillMd`-style parsing, `ingestGithubRepo`/`ingestLocalGitRepo`-style
directory scanning) applies with minimal new code, not a second parsing
implementation.

Catalog-side (`@skilljit/core`): a new `incidents` table + `incidents_fts` FTS5
virtual table, structurally identical to the existing `skills`/`skills_fts` pair.
New `Catalog` methods: `upsertIncidents()`, `getIncident(id)`, `searchIncidents()`.
Same additive-migration approach already used for `files_json`/`ledger_totals` —
`CREATE TABLE IF NOT EXISTS` plus an idempotent `ALTER TABLE`-style check for
pre-existing catalogs.

## Setup

Two one-time steps, both explicit and neither touching existing config silently —
consistent with how `skilljit adopt` already handles editing a config the user
relies on:

1. `skilljit incidents init <repo-url>` — records the incidents repo location in
   `~/.skilljit/incidents.json` (parallel to how `~/.skilljit/catalog.db` already
   holds the skills catalog). This is what the capture hook and `sync
   --incidents-repo` both read; it exists because the hook runs unattended from a
   git commit, not from a typed command, so the repo location can't be a
   re-specified-every-time CLI flag the way `--repo`/`--git` are for skills.
2. `skilljit incidents install-hook` — proposes the `PostToolUse` hook entry for
   `.claude/settings.json` and prints a diff, mirroring `skilljit init`'s
   preview-first posture; writing it requires `--yes`, same as `adopt`.

## Capture pipeline

**Trigger**: the `PostToolUse` hook on `Bash` installed above — the same
*mechanism* already used elsewhere in this environment (a `Stop` hook already runs
for an unrelated skill), now with a skilljit-provided entry. Not a raw git
`post-commit` hook, because the pipeline needs the actual Claude Code session
transcript, not just the commit.

Flow, on every `Bash` tool call:

1. The hook checks whether the command was `git commit` **and** the commit message
   matches a fix heuristic (`^fix:`, `fixes #`, `closes #`, `resolves #`, and
   similar conventional-commit/issue-closing patterns). Anything else is a no-op —
   a cheap regex check on every commit, no overhead on the common case.
2. If matched, it invokes `skilljit capture-incident <sha>` (new CLI command).
3. That command reads the current session's transcript (Claude Code already
   persists these under `~/.claude/projects/<project>/`) and the commit's diff,
   then asks Claude to synthesize the four narrative fields — symptom,
   investigation, root cause, fix — from them. The synthesis prompt explicitly
   instructs: paraphrase, never quote raw error output/log lines/values verbatim,
   use placeholders for anything that looks like a value rather than a pattern.
4. The synthesized text goes through the redaction pass (see Safety & governance)
   before anything touches disk.
5. If redaction passes, the record is written as a Markdown file and committed to
   the configured incidents repo (see Distribution). If redaction can't positively
   confirm the text is clean, capture **fails closed**: nothing is written or
   committed, and the developer gets a one-line note that manual review is needed.

The hook itself stays cheap (regex check on every commit); the expensive step
(transcript synthesis) only runs on the rare fix-like commit.

## New MCP tools

Two new tools on the MCP server, **opt-in** — present only when an incidents
source is configured, the same pattern `tool_find`/`tool_call` already use for
`upstreams`. A skilljit user who hasn't configured incidents stays on the existing
skills-only surface; nothing changes for them.

| Tool | Returns |
|---|---|
| `incident_find(symptom, limit=8)` | Cheap candidates: id, one-line symptom, root cause summary, date, repo, `verified` flag — same shape as `skill_find`. |
| `incident_load(id)` | Full record: investigation, root cause, fix, referenced commit. |

Same pull discipline as the rest of skilljit: nothing about past incidents sits in
context until Claude recognizes it's debugging something and calls `incident_find`
— no proactive-push infrastructure, no dependency on the experimental Channels
feature. Claude decides to call it the same way it already decides to call
`skill_find`, based on the tool's description.

## Distribution

Reuses the git-worktree sync infrastructure already built for skills
(`ingestLocalGitRepo`) — no new distribution mechanism, no new backend.

- **Separate source config from skills** — the repo recorded by `skilljit
  incidents init` (see Setup), not folded into the existing `--repo`/`--git` sync
  flags. Incidents carry real governance weight the public-skill sources don't;
  keeping them separate lets a team point skills at public repos while keeping
  incidents strictly on an internal-only repo, without the two ever being tangled
  in one sync call. Once configured, plain `skilljit sync` picks up new incidents
  from that repo automatically, no flag needed on every invocation.
- Capture (above) auto-commits the new incident file to that same incidents repo,
  on the developer's own machine, using their existing git credentials — no new
  auth, no new push mechanism.
- A teammate's next `skilljit sync` does a `git fetch` + worktree checkout against
  that repo (identical to today's skill sync) and picks up new incident files the
  same way it picks up new skills.

Net effect: propagation happens on each person's next `sync`, not instantly — a
deliberate tradeoff favoring "no new backend" over "real-time," matching the
explicit choice made during design.

## Safety & governance

This is the section that matters most, given automatic (unprompted) capture is the
highest-risk option in the design space. Defense in depth, three layers:

1. **Prompt-level**: the synthesis step is explicitly instructed to paraphrase and
   never quote raw error output, logs, or values verbatim — first line of defense,
   but an LLM instruction can be missed.
2. **Mechanical redaction pass**: a regex scan (the same category of pattern
   `gitleaks`/`truffleHog` use) for AWS-style keys, generic API-key/token shapes,
   JWTs, connection strings, emails, IP addresses — run on the synthesized text
   before it ever touches disk.
3. **Fail closed**: if the redaction pass can't positively confirm the text is
   clean, nothing gets written or committed. Capture silently aborts and logs a
   one-line note (`skilljit: incident capture skipped for <sha>, needs manual
   review`) rather than ever writing something unreviewed to a shared repo.

Plus a `verified` flag, defaulting to `false` on every auto-captured incident.
`incident_load` prepends a warning on unverified records, mirroring skilljit's
existing posture toward unaudited skills:

> ⚠️ This incident was auto-captured and hasn't been reviewed by a human. Verify
> before trusting it fully.

A human flips it to `true` via a plain PR review on the incidents repo (or a future
`skilljit incident verify <id>` command) — deliberately reusing existing review
infrastructure (git/PRs) rather than building a new UI.

## Non-goals (v1)

- **Real-time distribution.** Explicitly deferred — propagation is "next sync,"
  not instant. A shared backend/API is a much bigger scope increase and isn't
  justified until the git-sync approach is proven.
- **Proactive/unprompted surfacing.** `incident_find`/`incident_load` are pull
  tools, called when Claude decides to. No Channels-based push in v1 — the record
  format doesn't preclude adding this later, but it isn't built now.
- **Broader trigger than git commits.** Sessions that don't end in a matching
  commit (still debugging, fixed via a config change, abandoned) are not captured.
  This is a deliberate coverage/noise tradeoff, not an oversight.
- **Assuming this is safe from being subsumed by Anthropic.** Given the visible
  investment (Channels, two further open collaboration-feature issues), this
  should ship as a genuinely useful v1, not be over-invested in as a permanent
  moat.

## Open risks

- **Fix-heuristic false positives/negatives**: commit-message pattern matching
  will both miss real fixes (unconventional messages) and fire on non-fixes (a
  commit that merely mentions "fixes" in a comment). Acceptable for v1; revisit if
  signal quality proves too noisy in practice.
- **Redaction is necessarily incomplete**: regex-based scrubbing cannot catch every
  sensitive-data shape. The fail-closed behavior is the actual safety net, not the
  regex list's completeness — this must not be weakened without an equally strong
  replacement.
- **Transcript availability**: relies on Claude Code's on-disk transcript format
  and location remaining stable; this is an external dependency skilljit doesn't
  control.
