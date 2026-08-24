# Incident Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a teammate who hits a bug someone already fixed get that person's debugging context (symptom, investigation, root cause, fix) automatically, not just the code diff.

**Architecture:** A new `IncidentRecord` content type, stored as SKILL.md-style frontmatter+body Markdown files in a dedicated git repo. A Claude Code `PostToolUse` hook on `Bash` detects fix-like `git commit` calls and triggers capture: read the session transcript + commit diff, synthesize the four narrative fields via `claude -p`, redact, and (only if redaction succeeds) write+commit+push to a persistent local clone of the incidents repo. Teammates pull new incidents via the existing git-worktree sync already built for skills. Two new opt-in MCP tools (`incident_find`/`incident_load`) expose search+load with the same pull discipline as `skill_find`/`skill_load`.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (FTS5), the `yaml` package, Node `child_process`/`fs`, `@modelcontextprotocol/sdk`, `commander`.

**Spec:** [`docs/superpowers/specs/2026-08-24-incident-memory-design.md`](../specs/2026-08-24-incident-memory-design.md)

## Global Constraints

- Node engines: `@skilljit/core` changes must keep working on Node 16+ (no Node 18-only APIs); CLI/MCP changes must keep working on Node 18+ (existing floors — see root README's "Node version support" section).
- Every new git-touching operation must be injectable for tests (`execFileImpl`, matching the existing `ExecFileFn` shape in `packages/core/src/ingest/git-local.ts`) — no test may shell out to real `git` over the network.
- Frontmatter parsing must fail closed to `null`/skip on malformed input, matching `parseSkillMd`'s existing philosophy — never throw on a bad file.
- Any command that writes to a shared/external resource (a hook install, a git push) follows the existing dry-run-first, `--yes`-to-write pattern already used by `skilljit adopt` (see `packages/cli/src/commands/proxy.ts`).
- Redaction is fail-closed: if the redaction step itself throws, capture aborts without writing anything — this is the actual safety net per the spec, not regex completeness.
- New MCP tools (`incident_find`/`incident_load`) must be absent from the tool list entirely when no incidents catalog is configured — same conditional-registration pattern already used for `tool_find`/`tool_call` in `packages/mcp/src/server.ts`.

---

## Design decisions this plan locks in (not fully specified in the spec)

The spec describes behavior; these are the concrete mechanics needed to implement it, chosen for consistency with the existing codebase:

1. **Hook contract**: Claude Code invokes `PostToolUse` hooks with a JSON payload on stdin: `{ session_id, transcript_path, cwd, tool_name, tool_input: { command }, tool_response }`. The installed hook command is simply `skilljit capture-incident`, which reads this payload from stdin itself — no wrapper script needed.
2. **Fix-commit detection**: extract the `-m "..."` or `-m '...'` message from the Bash `command` string; skip (not an error) if the command isn't `git commit` or has no inline `-m` message. Regex-match the message against `/^(fix|fixes|fixed)[:(]|fixes #|closes #|resolves #/i`.
3. **Two separate local git states**: reading (sync) uses the existing ephemeral bare-mirror-plus-worktree approach (`ingestLocalGitRepo`'s mechanics, extracted into a reusable `withGitWorktree` helper). Writing (capture) uses a separate, persistent, normal (non-bare) local clone at `~/.skilljit/incidents-write/`, created once by `skilljit incidents init` and reused (pulled, written to, pushed) by every capture. These are deliberately different git states for different purposes.
4. **Incident file format**: `incidents/<YYYY-MM-DD>-<7-char-sha>.md`, YAML frontmatter (`symptom`, `rootCause`, `commitSha`, `repo`, `capturedAt`, `verified`, optional `filesTouched`) + a body with exact `## Investigation` and `## Fix` section headers.
5. **Synthesis call**: shells out to `claude -p "<prompt>" --output-format json` (Claude Code's own non-interactive mode, already installed and authenticated wherever the hook runs) asking for a JSON object `{"symptom":...,"investigation":...,"rootCause":...,"fix":...}`. Injectable via a `synthesizeImpl` parameter for tests.

---

### Task 1: `IncidentRecord` and `IncidentSearchHit` types

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: none (pure type addition; exercised by later tasks' tests)

**Interfaces:**
- Produces: `IncidentRecord`, `IncidentSearchHit` types, importable from `../types.js` within `packages/core`.

- [ ] **Step 1: Add the types**

Add to `packages/core/src/types.ts`, after the existing `ToolSearchHit` interface:

```ts
/** A captured debugging incident: symptom, investigation, root cause, and
 * fix from a real prod-bug fix, so a teammate who hits the same symptom
 * later gets the context, not just the code diff. */
export interface IncidentRecord {
  /** Stable unique id, e.g. "git:<repo-url>/incidents/a1b2c3d". */
  id: string;
  /** What was observed — the field incident_find searches against. */
  symptom: string;
  /** What was tried, what got ruled out. */
  investigation: string;
  rootCause: string;
  /** What changed, in prose — references the commit, doesn't replace it. */
  fix: string;
  commitSha: string;
  /** Where this incident came from, e.g. "git:git@example.com:team/incidents.git". */
  repo: string;
  filesTouched?: string[];
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** False until a human confirms this auto-captured record is accurate. */
  verified: boolean;
}

/** A search hit: an incident plus its relevance rank (lower = more relevant). */
export interface IncidentSearchHit {
  incident: Omit<IncidentRecord, "investigation" | "fix">;
  rank: number;
}
```

- [ ] **Step 2: Build to confirm no type errors**

Run: `cd packages/core && npm run build`
Expected: exits 0, no output beyond the tsc invocation line.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "Add IncidentRecord and IncidentSearchHit types"
```

---

### Task 2: `redactSecrets`

**Files:**
- Create: `packages/core/src/redact.ts`
- Test: `packages/core/test/redact.test.ts`

**Interfaces:**
- Produces: `redactSecrets(text: string): { clean: boolean; text: string }`, exported from `packages/core/src/redact.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/redact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts an AWS-style access key", () => {
    const result = redactSecrets("the key was AKIAABCDEFGHIJKLMNOP in the config");
    expect(result.clean).toBe(true);
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a GitHub personal access token", () => {
    const token = "ghp_" + "a".repeat(36);
    const result = redactSecrets(`auth failed with token ${token}`);
    expect(result.text).not.toContain(token);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactSecrets(`session token: ${jwt}`);
    expect(result.text).not.toContain(jwt);
  });

  it("redacts an email address", () => {
    const result = redactSecrets("reported by jane.doe@example.com in the ticket");
    expect(result.text).not.toContain("jane.doe@example.com");
  });

  it("redacts an IPv4 address", () => {
    const result = redactSecrets("connection refused from 10.20.30.40");
    expect(result.text).not.toContain("10.20.30.40");
  });

  it("redacts a database connection string", () => {
    const result = redactSecrets("postgres://user:pw@db.internal:5432/prod");
    expect(result.text).not.toContain("user:pw@db.internal");
  });

  it("leaves ordinary prose untouched", () => {
    const text = "The retry loop had an off-by-one error in the backoff calculation.";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.clean).toBe(true);
  });

  it("fails closed (clean: false) if redaction itself throws", () => {
    // @ts-expect-error deliberately passing a non-string to exercise the catch path
    const result = redactSecrets(null);
    expect(result.clean).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run test/redact.test.ts`
Expected: FAIL — `Cannot find module '../src/redact.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/redact.ts`:

```ts
export interface RedactResult {
  /** False only if the redaction pass itself failed to run — the signal
   * capture-incident uses to fail closed and write nothing, per the
   * design spec's Safety & governance section. Regex completeness is a
   * best-effort mechanical layer, not what "clean" is claiming. */
  clean: boolean;
  text: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+/gi,
];

/**
 * Best-effort mechanical secret scrubbing, run on every synthesized
 * incident field before it touches disk. This cannot catch every
 * sensitive-data shape — the actual safety net is capture-incident
 * failing closed if this function throws, not the pattern list being
 * exhaustive. See the design spec's "Open risks" section.
 */
export function redactSecrets(text: string): RedactResult {
  try {
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return { clean: true, text: redacted };
  } catch {
    return { clean: false, text: "" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/redact.test.ts`
Expected: PASS — 8 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/redact.ts packages/core/test/redact.test.ts
git commit -m "Add redactSecrets, the mechanical scrubbing layer for incident capture"
```

---

### Task 3: `parseIncidentMd` and `serializeIncidentMd`

**Files:**
- Create: `packages/core/src/ingest/incident-md.ts`
- Test: `packages/core/test/incident-md.test.ts`

**Interfaces:**
- Consumes: `IncidentRecord` from `../types.js` (Task 1).
- Produces: `parseIncidentMd(content: string, ctx: { source: string }): IncidentRecord | null` and `serializeIncidentMd(record: Omit<IncidentRecord, "id">): string`, exported from `packages/core/src/ingest/incident-md.ts`. Later tasks (5, 6, 11) import both.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/incident-md.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseIncidentMd, serializeIncidentMd } from "../src/ingest/incident-md.js";
import type { IncidentRecord } from "../src/types.js";

describe("serializeIncidentMd + parseIncidentMd", () => {
  const record: Omit<IncidentRecord, "id"> = {
    symptom: "Checkout requests time out under load after a deploy.",
    investigation: "Ruled out the payment provider. Traced it to a new DB index migration holding a lock.",
    rootCause: "The migration ran ACCESS EXCLUSIVE against a hot table without a maintenance window.",
    fix: "Reran the migration with CREATE INDEX CONCURRENTLY instead.",
    commitSha: "a1b2c3d4e5f6",
    repo: "git:git@example.com:acme/webapp.git",
    filesTouched: ["migrations/0042_add_index.sql"],
    capturedAt: "2026-08-24T12:00:00.000Z",
    verified: false,
  };

  it("round-trips every field through serialize -> parse", () => {
    const md = serializeIncidentMd(record);
    const parsed = parseIncidentMd(md, { source: record.repo });
    expect(parsed).not.toBeNull();
    expect(parsed?.symptom).toBe(record.symptom);
    expect(parsed?.investigation).toBe(record.investigation);
    expect(parsed?.rootCause).toBe(record.rootCause);
    expect(parsed?.fix).toBe(record.fix);
    expect(parsed?.commitSha).toBe(record.commitSha);
    expect(parsed?.filesTouched).toEqual(record.filesTouched);
    expect(parsed?.verified).toBe(false);
  });

  it("derives id from source + short commit sha", () => {
    const md = serializeIncidentMd(record);
    const parsed = parseIncidentMd(md, { source: record.repo });
    expect(parsed?.id).toBe(`${record.repo}/incidents/a1b2c3d`);
  });

  it("defaults verified to false when the frontmatter omits it", () => {
    const md = serializeIncidentMd(record).replace(/verified: false\n/, "");
    const parsed = parseIncidentMd(md, { source: record.repo });
    expect(parsed?.verified).toBe(false);
  });

  it("returns null for content with no frontmatter", () => {
    expect(parseIncidentMd("just some text, no frontmatter", { source: "x" })).toBeNull();
  });

  it("returns null when a required frontmatter field is missing", () => {
    const md = serializeIncidentMd(record).replace(/rootCause: .*\n/, "");
    expect(parseIncidentMd(md, { source: record.repo })).toBeNull();
  });

  it("returns null when the body is missing the Fix section", () => {
    const md = serializeIncidentMd(record).replace(/## Fix[\s\S]*/, "");
    expect(parseIncidentMd(md, { source: record.repo })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run test/incident-md.test.ts`
Expected: FAIL — `Cannot find module '../src/ingest/incident-md.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/ingest/incident-md.ts`:

```ts
import YAML from "yaml";
import type { IncidentRecord } from "../types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const INVESTIGATION_RE = /## Investigation\r?\n+([\s\S]*?)(?=\r?\n## Fix\r?\n|$)/;
const FIX_RE = /## Fix\r?\n+([\s\S]*)$/;

export interface IncidentParseContext {
  /** e.g. "git:git@example.com:acme/webapp.git" */
  source: string;
}

/**
 * Parse a captured incident Markdown file back into an IncidentRecord.
 * Mirrors parseSkillMd's philosophy: a malformed record disappears
 * quietly (returns null) rather than corrupting the catalog.
 */
export function parseIncidentMd(content: string, ctx: IncidentParseContext): IncidentRecord | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;

  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1]);
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== "object") return null;

  const fm = frontmatter as Record<string, unknown>;
  const { symptom, rootCause, commitSha, repo, capturedAt } = fm;
  if (
    typeof symptom !== "string" ||
    typeof rootCause !== "string" ||
    typeof commitSha !== "string" ||
    typeof repo !== "string" ||
    typeof capturedAt !== "string"
  ) {
    return null;
  }
  const verified = typeof fm.verified === "boolean" ? fm.verified : false;
  const filesTouched = Array.isArray(fm.filesTouched) ? fm.filesTouched.map(String) : undefined;

  const body = match[2] ?? "";
  const investigationMatch = INVESTIGATION_RE.exec(body);
  const fixMatch = FIX_RE.exec(body);
  if (!investigationMatch || !fixMatch) return null;

  const id = `${ctx.source}/incidents/${commitSha.slice(0, 7)}`;

  return {
    id,
    symptom,
    investigation: investigationMatch[1].trim(),
    rootCause,
    fix: fixMatch[1].trim(),
    commitSha,
    repo,
    filesTouched,
    capturedAt,
    verified,
  };
}

/** Serialize a captured incident to the Markdown format parseIncidentMd
 * reads back. Deliberately mirrors the SKILL.md frontmatter+body shape. */
export function serializeIncidentMd(record: Omit<IncidentRecord, "id">): string {
  const frontmatter: Record<string, unknown> = {
    symptom: record.symptom,
    rootCause: record.rootCause,
    commitSha: record.commitSha,
    repo: record.repo,
    capturedAt: record.capturedAt,
    verified: record.verified,
  };
  if (record.filesTouched && record.filesTouched.length > 0) {
    frontmatter.filesTouched = record.filesTouched;
  }
  const yamlBlock = YAML.stringify(frontmatter).trimEnd();
  return `---\n${yamlBlock}\n---\n## Investigation\n\n${record.investigation}\n\n## Fix\n\n${record.fix}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/incident-md.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ingest/incident-md.ts packages/core/test/incident-md.test.ts
git commit -m "Add parseIncidentMd/serializeIncidentMd, the incident file format"
```

---

### Task 4: Catalog support for incidents

**Files:**
- Modify: `packages/core/src/catalog.ts`
- Test: `packages/core/test/catalog.test.ts`

**Interfaces:**
- Consumes: `IncidentRecord`, `IncidentSearchHit` from `../types.js` (Task 1).
- Produces: `Catalog.upsertIncidents(incidents: IncidentRecord[]): void`, `Catalog.getIncident(id: string): IncidentRecord | undefined`, `Catalog.searchIncidents(query: string, limit?: number): IncidentSearchHit[]`, `Catalog.incidentCount(): number`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/catalog.test.ts`, after the existing tests but before the closing `});` of the `describe("Catalog", ...)` block:

```ts
  function makeIncident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
    return {
      id: "git:acme/webapp/incidents/a1b2c3d",
      symptom: "Checkout requests time out under load after a deploy.",
      investigation: "Ruled out the payment provider. Traced it to a migration holding a lock.",
      rootCause: "The migration ran ACCESS EXCLUSIVE against a hot table.",
      fix: "Reran the migration with CREATE INDEX CONCURRENTLY.",
      commitSha: "a1b2c3d4e5f6",
      repo: "git:git@example.com:acme/webapp.git",
      capturedAt: "2026-08-24T12:00:00.000Z",
      verified: false,
      ...overrides,
    };
  }

  it("upserts and retrieves an incident by id", () => {
    catalog.upsertIncidents([makeIncident()]);
    const found = catalog.getIncident("git:acme/webapp/incidents/a1b2c3d");
    expect(found?.symptom).toContain("Checkout requests time out");
    expect(found?.fix).toContain("CREATE INDEX CONCURRENTLY");
  });

  it("incident upsert is idempotent — re-inserting updates, not duplicates", () => {
    catalog.upsertIncidents([makeIncident()]);
    catalog.upsertIncidents([makeIncident({ verified: true })]);
    expect(catalog.incidentCount()).toBe(1);
    expect(catalog.getIncident("git:acme/webapp/incidents/a1b2c3d")?.verified).toBe(true);
  });

  it("finds an incident by keyword match in the symptom", () => {
    catalog.upsertIncidents([
      makeIncident(),
      makeIncident({ id: "git:acme/webapp/incidents/z9y8x7w", symptom: "Login page returns 500 after cache flush." }),
    ]);
    const hits = catalog.searchIncidents("checkout timeout", 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].incident.id).toBe("git:acme/webapp/incidents/a1b2c3d");
  });

  it("incident search hits omit investigation and fix (cheap candidates only)", () => {
    catalog.upsertIncidents([makeIncident()]);
    const hits = catalog.searchIncidents("checkout", 8);
    expect((hits[0].incident as any).investigation).toBeUndefined();
    expect((hits[0].incident as any).fix).toBeUndefined();
  });

  it("counts incidents independently of skills", () => {
    catalog.upsertSkills([makeSkill()]);
    catalog.upsertIncidents([makeIncident()]);
    expect(catalog.count()).toBe(1);
    expect(catalog.incidentCount()).toBe(1);
  });
```

Add the import at the top of the file:

```ts
import type { IncidentRecord } from "../src/types.js";
```

(This adds to the existing `import type { SkillRecord } from "../src/types.js";` line — combine into one import statement.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run test/catalog.test.ts`
Expected: FAIL — `catalog.upsertIncidents is not a function`

- [ ] **Step 3: Write the implementation**

In `packages/core/src/catalog.ts`, update the import line:

```ts
import type { SkillRecord, SkillSearchHit, ToolRecord, ToolSearchHit, IncidentRecord, IncidentSearchHit } from "./types.js";
```

Add to the `SCHEMA` template string, after the `tools_fts` virtual table definition and before the closing backtick:

```sql

CREATE TABLE IF NOT EXISTS incidents (
  id           TEXT PRIMARY KEY,
  symptom      TEXT NOT NULL,
  investigation TEXT NOT NULL,
  root_cause   TEXT NOT NULL,
  fix          TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  repo         TEXT NOT NULL,
  files_touched TEXT,
  captured_at  TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(
  id UNINDEXED,
  symptom,
  tokenize = 'porter unicode61'
);
```

Add these methods to the `Catalog` class, after `toolCount()` and before the cross-session-ledger methods added in an earlier change (i.e., right before the `// ---- Cross-session token ledger` comment, or at the end of the class if that comment isn't present):

```ts
  // ---- Incidents -----------------------------------------------------

  upsertIncidents(incidents: IncidentRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO incidents (id, symptom, investigation, root_cause, fix, commit_sha, repo, files_touched, captured_at, verified)
      VALUES (@id, @symptom, @investigation, @rootCause, @fix, @commitSha, @repo, @filesTouched, @capturedAt, @verified)
      ON CONFLICT(id) DO UPDATE SET
        symptom = excluded.symptom,
        investigation = excluded.investigation,
        root_cause = excluded.root_cause,
        fix = excluded.fix,
        commit_sha = excluded.commit_sha,
        repo = excluded.repo,
        files_touched = excluded.files_touched,
        captured_at = excluded.captured_at,
        verified = excluded.verified
    `);
    const deleteFts = this.db.prepare(`DELETE FROM incidents_fts WHERE id = ?`);
    const insertFts = this.db.prepare(`INSERT INTO incidents_fts (id, symptom) VALUES (?, ?)`);

    const tx = this.db.transaction((rows: IncidentRecord[]) => {
      for (const inc of rows) {
        upsert.run({
          id: inc.id,
          symptom: inc.symptom,
          investigation: inc.investigation,
          rootCause: inc.rootCause,
          fix: inc.fix,
          commitSha: inc.commitSha,
          repo: inc.repo,
          filesTouched: inc.filesTouched && inc.filesTouched.length > 0 ? JSON.stringify(inc.filesTouched) : null,
          capturedAt: inc.capturedAt,
          verified: inc.verified ? 1 : 0,
        });
        deleteFts.run(inc.id);
        insertFts.run(inc.id, inc.symptom);
      }
    });
    tx(incidents);
  }

  getIncident(id: string): IncidentRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    return rowToIncident(row);
  }

  searchIncidents(query: string, limit = 8): IncidentSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `
        SELECT i.id, i.symptom, i.root_cause, i.commit_sha, i.repo, i.captured_at, i.verified,
               bm25(incidents_fts) AS rank
        FROM incidents_fts
        JOIN incidents i ON i.id = incidents_fts.id
        WHERE incidents_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(ftsQuery, limit) as any[];
    return rows.map((row) => ({
      incident: {
        id: row.id,
        symptom: row.symptom,
        rootCause: row.root_cause,
        commitSha: row.commit_sha,
        repo: row.repo,
        capturedAt: row.captured_at,
        verified: !!row.verified,
      } as Omit<IncidentRecord, "investigation" | "fix">,
      rank: row.rank,
    }));
  }

  incidentCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM incidents`).get() as { c: number };
    return row.c;
  }
```

Add this helper function near the existing `rowToSkill` function at the bottom of the file:

```ts
function rowToIncident(row: any): IncidentRecord {
  return {
    id: row.id,
    symptom: row.symptom,
    investigation: row.investigation,
    rootCause: row.root_cause,
    fix: row.fix,
    commitSha: row.commit_sha,
    repo: row.repo,
    filesTouched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
    capturedAt: row.captured_at,
    verified: !!row.verified,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/catalog.test.ts`
Expected: PASS — all catalog tests including the 5 new ones

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/catalog.ts packages/core/test/catalog.test.ts
git commit -m "Add incidents/incidents_fts catalog tables and Catalog incident methods"
```

---

### Task 5: Extract `withGitWorktree` from `ingestLocalGitRepo`

**Files:**
- Modify: `packages/core/src/ingest/git-local.ts`
- Test: `packages/core/test/ingest-git-local.test.ts` (existing — must still pass unmodified)

**Interfaces:**
- Produces: `withGitWorktree<T>(url: string, opts: { cacheDir?: string; ref?: string; execFileImpl?: ExecFileFn }, scan: (worktreeDir: string) => T | Promise<T>): Promise<T>`, exported from `packages/core/src/ingest/git-local.ts`. Task 6 consumes this.
- Consumes: nothing new — this is a refactor of existing code, no new dependencies.

This is a pure refactor: `ingestLocalGitRepo`'s clone/fetch/worktree-add/cleanup mechanics move into a new reusable function; `ingestLocalGitRepo` becomes a thin caller. Behavior must not change — the existing test file must pass without modification.

- [ ] **Step 1: Confirm the existing tests pass before refactoring (baseline)**

Run: `cd packages/core && npx vitest run test/ingest-git-local.test.ts`
Expected: PASS — 4 tests passed (this is the pre-refactor baseline; if this fails, stop and investigate before proceeding)

- [ ] **Step 2: Extract the helper**

Replace the body of `packages/core/src/ingest/git-local.ts` from the `export async function ingestLocalGitRepo` line through the end of that function (but keep `walkSkillDirs`, `collectSiblingFiles`, and everything above `ingestLocalGitRepo` unchanged) with:

```ts
export interface WithGitWorktreeOptions {
  cacheDir?: string;
  ref?: string;
  execFileImpl?: ExecFileFn;
}

/**
 * Clone (or reuse a cached bare mirror of) an arbitrary git remote, check
 * out a throwaway worktree, hand its path to `scan`, then clean up —
 * regardless of whether `scan` throws. Shared by every content type that
 * gets ingested from a git remote (skills today, incidents in Task 6),
 * so the clone/fetch/worktree mechanics exist exactly once.
 */
export async function withGitWorktree<T>(
  url: string,
  opts: WithGitWorktreeOptions,
  scan: (worktreeDir: string) => T | Promise<T>,
): Promise<T> {
  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".skilljit", "git-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bareDir = path.join(cacheDir, `${cacheKeyForUrl(url)}.git`);

  if (!fs.existsSync(bareDir)) {
    await run("git", ["clone", "--mirror", "--quiet", url, bareDir]);
  } else {
    await run("git", ["--git-dir", bareDir, "fetch", "--quiet", "--prune", "origin"]);
  }

  const checkoutRef = opts.ref ?? "HEAD";
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-wt-"));
  fs.rmdirSync(worktreeDir);

  try {
    await run("git", ["--git-dir", bareDir, "worktree", "add", "--detach", "--quiet", worktreeDir, checkoutRef]);
    return await scan(worktreeDir);
  } finally {
    await run("git", ["--git-dir", bareDir, "worktree", "remove", "--force", worktreeDir]).catch(() => {});
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

export interface LocalGitIngestOptions extends WithGitWorktreeOptions {}

/**
 * Ingest every SKILL.md in an arbitrary git repository — self-hosted,
 * GitLab, Bitbucket, an internal server, or a private GitHub repo reached
 * over SSH — anywhere the `git` binary on this machine can already
 * authenticate. See withGitWorktree for the clone/fetch/worktree mechanics
 * this reuses.
 */
export async function ingestLocalGitRepo(
  url: string,
  opts: LocalGitIngestOptions = {},
): Promise<SkillRecord[]> {
  const source = `git:${url}`;
  return withGitWorktree(url, opts, (worktreeDir) => {
    const skillDirs: string[] = [];
    walkSkillDirs(worktreeDir, worktreeDir, skillDirs);

    const results: SkillRecord[] = [];
    for (const relDir of skillDirs) {
      const absDir = path.join(worktreeDir, relDir);
      const skillMdPath = path.join(absDir, "SKILL.md");
      const content = fs.readFileSync(skillMdPath, "utf8");
      const skillPath = relDir === "" ? "SKILL.md" : `${relDir}/SKILL.md`;
      const parsed = parseSkillMd(content, { source, path: skillPath });
      if (!parsed) continue;

      if (relDir !== "") {
        const files: SkillRecord["files"] = [];
        collectSiblingFiles(absDir, absDir, files);
        if (files.length > 0) parsed.files = files;
      }

      results.push(parsed);
    }
    return results;
  });
}
```

- [ ] **Step 3: Run the existing tests to confirm the refactor didn't change behavior**

Run: `cd packages/core && npx vitest run test/ingest-git-local.test.ts`
Expected: PASS — same 4 tests as the Step 1 baseline, unmodified

- [ ] **Step 4: Export `withGitWorktree` from the package**

In `packages/core/src/index.ts`, change:

```ts
export { ingestLocalGitRepo } from "./ingest/git-local.js";
export type { LocalGitIngestOptions, ExecFileFn } from "./ingest/git-local.js";
```

to:

```ts
export { ingestLocalGitRepo, withGitWorktree } from "./ingest/git-local.js";
export type { LocalGitIngestOptions, WithGitWorktreeOptions, ExecFileFn } from "./ingest/git-local.js";
```

- [ ] **Step 5: Build to confirm no type errors**

Run: `cd packages/core && npm run build`
Expected: exits 0

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ingest/git-local.ts packages/core/src/index.ts
git commit -m "Extract withGitWorktree from ingestLocalGitRepo for reuse by incidents ingestion"
```

---

### Task 6: `ingestIncidentsFromGitRepo`

**Files:**
- Create: `packages/core/src/ingest/incidents-git.ts`
- Test: `packages/core/test/ingest-incidents-git.test.ts`

**Interfaces:**
- Consumes: `withGitWorktree` and `WithGitWorktreeOptions` from `./git-local.js` (Task 5); `parseIncidentMd` from `./incident-md.js` (Task 3); `IncidentRecord` from `../types.js` (Task 1).
- Produces: `ingestIncidentsFromGitRepo(url: string, opts?: WithGitWorktreeOptions): Promise<IncidentRecord[]>`, exported from `packages/core/src/ingest/incidents-git.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/ingest-incidents-git.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestIncidentsFromGitRepo } from "../src/ingest/incidents-git.js";
import { serializeIncidentMd } from "../src/ingest/incident-md.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("ingestIncidentsFromGitRepo", () => {
  let srcRepo: string;
  let cacheDir: string;

  beforeEach(() => {
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-src-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cache-"));
    git(srcRepo, ["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    fs.rmSync(srcRepo, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("ingests every incident file under incidents/", () => {
    fs.mkdirSync(path.join(srcRepo, "incidents"));
    const md = serializeIncidentMd({
      symptom: "Checkout requests time out under load after a deploy.",
      investigation: "Traced it to a migration holding a lock.",
      rootCause: "ACCESS EXCLUSIVE lock on a hot table.",
      fix: "Reran with CREATE INDEX CONCURRENTLY.",
      commitSha: "a1b2c3d4e5f6",
      repo: `git:${srcRepo}`,
      capturedAt: "2026-08-24T12:00:00.000Z",
      verified: false,
    });
    fs.writeFileSync(path.join(srcRepo, "incidents", "2026-08-24-a1b2c3d.md"), md);
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add incident"]);

    const incidents = await ingestIncidentsFromGitRepo(srcRepo, { cacheDir });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].symptom).toContain("Checkout requests time out");
    expect(incidents[0].id).toBe(`git:${srcRepo}/incidents/a1b2c3d`);
  });

  it("ignores non-incident files under incidents/ and files outside it", () => {
    fs.mkdirSync(path.join(srcRepo, "incidents"));
    fs.writeFileSync(path.join(srcRepo, "incidents", "README.md"), "# not an incident, no frontmatter");
    fs.writeFileSync(path.join(srcRepo, "unrelated.md"), "---\nsymptom: x\n---\nnot in incidents/");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add noise"]);

    const incidents = await ingestIncidentsFromGitRepo(srcRepo, { cacheDir });
    expect(incidents).toHaveLength(0);
  });

  it("returns an empty array when there is no incidents/ directory at all", async () => {
    fs.writeFileSync(path.join(srcRepo, "README.md"), "# empty repo");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

    const incidents = await ingestIncidentsFromGitRepo(srcRepo, { cacheDir });
    expect(incidents).toEqual([]);
  });
});
```

Note: the first test uses `await` inside an `it(...)` callback that isn't declared `async` — fix this when writing the file by declaring the callback `async ()  => { ... }` for that test (the other two already do, matching the existing style in `ingest-git-local.test.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run test/ingest-incidents-git.test.ts`
Expected: FAIL — `Cannot find module '../src/ingest/incidents-git.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/ingest/incidents-git.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { withGitWorktree } from "./git-local.js";
import type { WithGitWorktreeOptions } from "./git-local.js";
import { parseIncidentMd } from "./incident-md.js";
import type { IncidentRecord } from "../types.js";

/**
 * Ingest every captured incident file under incidents/ in an arbitrary
 * git repository, using the same clone/fetch/worktree mechanics as
 * ingestLocalGitRepo (see withGitWorktree). Distinct from skills
 * ingestion: incidents are flat files directly under incidents/, one
 * record per file, no bundled sibling files.
 */
export async function ingestIncidentsFromGitRepo(
  url: string,
  opts: WithGitWorktreeOptions = {},
): Promise<IncidentRecord[]> {
  const source = `git:${url}`;
  return withGitWorktree(url, opts, (worktreeDir) => {
    const incidentsDir = path.join(worktreeDir, "incidents");
    if (!fs.existsSync(incidentsDir)) return [];

    const results: IncidentRecord[] = [];
    for (const entry of fs.readdirSync(incidentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(incidentsDir, entry.name), "utf8");
      const parsed = parseIncidentMd(content, { source });
      if (parsed) results.push(parsed);
    }
    return results;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/ingest-incidents-git.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Export from the package**

In `packages/core/src/index.ts`, add:

```ts
export { ingestIncidentsFromGitRepo } from "./ingest/incidents-git.js";
export { parseIncidentMd, serializeIncidentMd } from "./ingest/incident-md.js";
export type { IncidentParseContext } from "./ingest/incident-md.js";
export { redactSecrets } from "./redact.js";
export type { RedactResult } from "./redact.js";
export type { IncidentRecord, IncidentSearchHit } from "./types.js";
```

(Add `IncidentRecord, IncidentSearchHit` to the existing `export type { SkillRecord, SkillFile, ... }` line instead if that's cleaner — either way, both types must be exported from the package root.)

- [ ] **Step 6: Build to confirm no type errors**

Run: `cd packages/core && npm run build`
Expected: exits 0

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ingest/incidents-git.ts packages/core/test/ingest-incidents-git.test.ts packages/core/src/index.ts
git commit -m "Add ingestIncidentsFromGitRepo and export the incidents ingestion API"
```

---

### Task 7: Incidents config (`~/.skilljit/incidents.json`) and `skilljit incidents init`

**Files:**
- Create: `packages/cli/src/commands/incidents.ts`
- Test: `packages/cli/test/incidents.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` type shape (matches `packages/core`'s, defined locally or imported — import it from `@skilljit/core`).
- Produces: `readIncidentsConfig(stateDir: string): IncidentsConfig | undefined`, `writeIncidentsConfig(stateDir: string, config: IncidentsConfig): void`, `cmdIncidentsInit(opts: { repoUrl: string; stateDir: string; execFileImpl?: ExecFileFn }, log: (s: string) => void): Promise<void>`, all exported from `packages/cli/src/commands/incidents.ts`. Tasks 8–10 and bin.ts (Task 11) consume `IncidentsConfig`, `readIncidentsConfig`, `cmdIncidentsInit`.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/incidents.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readIncidentsConfig, writeIncidentsConfig, cmdIncidentsInit } from "../src/commands/incidents.js";

describe("incidents config", () => {
  let stateDir: string;
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it("returns undefined when no config file exists yet", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    expect(readIncidentsConfig(stateDir)).toBeUndefined();
  });

  it("round-trips a written config", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    writeIncidentsConfig(stateDir, { repoUrl: "git@example.com:acme/incidents.git", localClonePath: "/tmp/x" });
    expect(readIncidentsConfig(stateDir)).toEqual({
      repoUrl: "git@example.com:acme/incidents.git",
      localClonePath: "/tmp/x",
    });
  });
});

describe("cmdIncidentsInit", () => {
  let stateDir: string;
  let srcRepo: string;
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(srcRepo, { recursive: true, force: true });
  });

  it("clones the repo and writes the config", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-cfg-"));
    srcRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-incidents-init-src-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: srcRepo });
    fs.writeFileSync(path.join(srcRepo, "README.md"), "# incidents");
    execFileSync("git", ["add", "-A"], { cwd: srcRepo });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
      cwd: srcRepo,
    });

    const logs: string[] = [];
    await cmdIncidentsInit({ repoUrl: srcRepo, stateDir }, (l) => logs.push(l));

    const config = readIncidentsConfig(stateDir);
    expect(config?.repoUrl).toBe(srcRepo);
    expect(fs.existsSync(path.join(config!.localClonePath, "README.md"))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/incidents.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/commands/incidents.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileFn } from "@skilljit/core";

const execFileAsync = promisify(execFile);

export interface IncidentsConfig {
  repoUrl: string;
  localClonePath: string;
}

function configPath(stateDir: string): string {
  return path.join(stateDir, "incidents.json");
}

export function readIncidentsConfig(stateDir: string): IncidentsConfig | undefined {
  const file = configPath(stateDir);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as IncidentsConfig;
}

export function writeIncidentsConfig(stateDir: string, config: IncidentsConfig): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath(stateDir), JSON.stringify(config, null, 2));
}

export interface IncidentsInitOptions {
  repoUrl: string;
  stateDir: string;
  execFileImpl?: ExecFileFn;
}

/**
 * One-time setup: clones the incidents repo into a persistent local
 * working copy (distinct from the ephemeral bare-mirror worktrees sync
 * uses for reading) and records its location, so capture-incident has
 * somewhere durable to commit+push into.
 */
export async function cmdIncidentsInit(opts: IncidentsInitOptions, log: (s: string) => void): Promise<void> {
  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const localClonePath = path.join(opts.stateDir, "incidents-write");

  if (fs.existsSync(localClonePath)) {
    log(`Updating existing local clone at ${localClonePath} ...`);
    await run("git", ["-C", localClonePath, "pull", "--quiet"]);
  } else {
    log(`Cloning ${opts.repoUrl} to ${localClonePath} ...`);
    fs.mkdirSync(opts.stateDir, { recursive: true });
    await run("git", ["clone", "--quiet", opts.repoUrl, localClonePath]);
  }

  writeIncidentsConfig(opts.stateDir, { repoUrl: opts.repoUrl, localClonePath });
  log(`Incidents repo configured: ${opts.repoUrl}`);
  log(`Run \`skilljit incidents install-hook\` next to capture incidents automatically.`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/incidents.ts packages/cli/test/incidents.test.ts
git commit -m "Add incidents config storage and skilljit incidents init"
```

---

### Task 8: `skilljit incidents install-hook`

**Files:**
- Modify: `packages/cli/src/commands/incidents.ts`
- Test: `packages/cli/test/incidents.test.ts`

**Interfaces:**
- Produces: `cmdIncidentsInstallHook(opts: { settingsPath: string; yes?: boolean }, log: (s: string) => void): Promise<void>`, added to `packages/cli/src/commands/incidents.ts`.

Follows the existing dry-run-first pattern from `packages/cli/src/commands/proxy.ts`'s `cmdAdopt`: without `--yes`, print what would change and stop; with `--yes`, write it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/incidents.test.ts`:

```ts
describe("cmdIncidentsInstallHook", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is a dry run by default — prints the change but doesn't write it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

    const logs: string[] = [];
    const { cmdIncidentsInstallHook } = await import("../src/commands/incidents.js");
    await cmdIncidentsInstallHook({ settingsPath }, (l) => logs.push(l));

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks).toBeUndefined();
    expect(logs.join("\n")).toContain("--yes");
  });

  it("writes the hook entry when --yes is passed, preserving existing settings", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

    const { cmdIncidentsInstallHook } = await import("../src/commands/incidents.js");
    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "skilljit capture-incident" }] },
    ]);
  });

  it("appends to an existing PostToolUse hook list instead of overwriting it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
    );

    const { cmdIncidentsInstallHook } = await import("../src/commands/incidents.js");
    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[1].matcher).toBe("Bash");
  });

  it("is idempotent — running it twice doesn't duplicate the hook entry", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-hook-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2));

    const { cmdIncidentsInstallHook } = await import("../src/commands/incidents.js");
    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});
    await cmdIncidentsInstallHook({ settingsPath, yes: true }, () => {});

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: FAIL — `cmdIncidentsInstallHook is not a function` (or not exported)

- [ ] **Step 3: Write the implementation**

Add to `packages/cli/src/commands/incidents.ts`:

```ts
const CAPTURE_HOOK_ENTRY = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "skilljit capture-incident" }],
};

export interface IncidentsInstallHookOptions {
  settingsPath: string;
  yes?: boolean;
}

/**
 * Proposes (or, with --yes, writes) the PostToolUse hook entry that
 * triggers incident capture on fix-like git commits. Mirrors cmdAdopt's
 * dry-run-first posture — never edits a settings file the user relies on
 * without explicit confirmation.
 */
export async function cmdIncidentsInstallHook(opts: IncidentsInstallHookOptions, log: (s: string) => void): Promise<void> {
  const settings = fs.existsSync(opts.settingsPath)
    ? (JSON.parse(fs.readFileSync(opts.settingsPath, "utf8")) as Record<string, any>)
    : {};

  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  const alreadyInstalled = settings.hooks.PostToolUse.some(
    (entry: any) => entry.matcher === "Bash" && entry.hooks?.some((h: any) => h.command === "skilljit capture-incident"),
  );

  if (alreadyInstalled) {
    log(`Hook already installed in ${opts.settingsPath}.`);
    return;
  }

  if (!opts.yes) {
    log(`This will add a PostToolUse hook to ${opts.settingsPath}:`);
    log(JSON.stringify(CAPTURE_HOOK_ENTRY, null, 2));
    log(`Re-run with --yes to write it.`);
    return;
  }

  settings.hooks.PostToolUse.push(CAPTURE_HOOK_ENTRY);
  fs.writeFileSync(opts.settingsPath, JSON.stringify(settings, null, 2));
  log(`Hook installed in ${opts.settingsPath}.`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: PASS — 7 tests passed (3 from Task 7 + 4 from this task)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/incidents.ts packages/cli/test/incidents.test.ts
git commit -m "Add skilljit incidents install-hook (dry-run-first, matching adopt's safety pattern)"
```

---

### Task 9: Fix-commit detection and the synthesis call

**Files:**
- Modify: `packages/cli/src/commands/incidents.ts`
- Test: `packages/cli/test/incidents.test.ts`

**Interfaces:**
- Produces: `looksLikeFixCommit(bashCommand: string): boolean`, `SynthesizedIncident` type, `synthesizeIncident(transcript: string, diff: string, synthesizeImpl?: (prompt: string) => Promise<string>): Promise<SynthesizedIncident>`, all added to `packages/cli/src/commands/incidents.ts`. Task 10 consumes all three.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/incidents.test.ts`:

```ts
describe("looksLikeFixCommit", () => {
  it("matches conventional fix-prefixed messages", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit -m "fix: checkout timeout under load"`)).toBe(true);
    expect(looksLikeFixCommit(`git commit -m 'fixes #123'`)).toBe(true);
    expect(looksLikeFixCommit(`git commit -m "closes #45, resolved the race"`)).toBe(true);
  });

  it("does not match unrelated commits", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit -m "add new dashboard widget"`)).toBe(false);
  });

  it("does not match non-commit bash commands", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git status`)).toBe(false);
    expect(looksLikeFixCommit(`npm test`)).toBe(false);
  });

  it("does not match a git commit with no inline message", async () => {
    const { looksLikeFixCommit } = await import("../src/commands/incidents.js");
    expect(looksLikeFixCommit(`git commit`)).toBe(false);
  });
});

describe("synthesizeIncident", () => {
  it("calls the injected synthesizeImpl and parses its JSON response", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const fakeSynthesize = async (_prompt: string) =>
      JSON.stringify({
        symptom: "Checkout timed out",
        investigation: "Ruled out payments",
        rootCause: "Lock contention",
        fix: "Reran migration concurrently",
      });

    const result = await synthesizeIncident("transcript text", "diff text", fakeSynthesize);
    expect(result.symptom).toBe("Checkout timed out");
    expect(result.fix).toBe("Reran migration concurrently");
  });

  it("throws a clear error if the response isn't valid JSON with the expected fields", async () => {
    const { synthesizeIncident } = await import("../src/commands/incidents.js");
    const fakeSynthesize = async () => "not json";
    await expect(synthesizeIncident("t", "d", fakeSynthesize)).rejects.toThrow(/synthes/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: FAIL — `looksLikeFixCommit is not a function`

- [ ] **Step 3: Write the implementation**

Add to `packages/cli/src/commands/incidents.ts`:

```ts
const FIX_MESSAGE_RE = /^(fix|fixes|fixed)[:(]|fixes #|closes #|resolves #/i;
const INLINE_MESSAGE_RE = /-m\s+"([^"]*)"|-m\s+'([^']*)'/;

/** Extracts a `git commit -m "..."` message and checks it against a
 * fix-commit heuristic. A `git commit` with no inline -m (opens $EDITOR)
 * is intentionally not matched — this is a v1 scope limit, not a bug. */
export function looksLikeFixCommit(bashCommand: string): boolean {
  if (!/\bgit\s+commit\b/.test(bashCommand)) return false;
  const messageMatch = INLINE_MESSAGE_RE.exec(bashCommand);
  if (!messageMatch) return false;
  const message = messageMatch[1] ?? messageMatch[2] ?? "";
  return FIX_MESSAGE_RE.test(message);
}

export interface SynthesizedIncident {
  symptom: string;
  investigation: string;
  rootCause: string;
  fix: string;
}

function defaultSynthesizeImpl(prompt: string): Promise<string> {
  // Reuses the execFileAsync already defined at module scope in Task 7 —
  // no second promisify(execFile) needed.
  return execFileAsync("claude", ["-p", prompt, "--output-format", "json"]).then((r) => r.stdout);
}

/**
 * Synthesizes the four narrative incident fields from a session
 * transcript and a commit diff. Shells out to `claude -p` by default
 * (Claude Code's own non-interactive mode — already installed and
 * authenticated wherever the capture hook runs), injectable for tests.
 */
export async function synthesizeIncident(
  transcript: string,
  diff: string,
  synthesizeImpl: (prompt: string) => Promise<string> = defaultSynthesizeImpl,
): Promise<SynthesizedIncident> {
  const prompt =
    "You are summarizing a debugging session that just ended in a bug fix, for a teammate " +
    "who might hit the same problem later. From the transcript and diff below, respond with " +
    'ONLY a JSON object: {"symptom": "...", "investigation": "...", "rootCause": "...", "fix": "..."}. ' +
    "Paraphrase — never quote raw error output, log lines, or literal values verbatim; use " +
    "placeholders for anything that looks like a value rather than a pattern.\n\n" +
    `TRANSCRIPT:\n${transcript}\n\nDIFF:\n${diff}`;

  const raw = await synthesizeImpl(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`synthesizeIncident: response was not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as any).symptom !== "string" ||
    typeof (parsed as any).investigation !== "string" ||
    typeof (parsed as any).rootCause !== "string" ||
    typeof (parsed as any).fix !== "string"
  ) {
    throw new Error(`synthesizeIncident: response was missing required fields: ${raw.slice(0, 200)}`);
  }
  return parsed as SynthesizedIncident;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: PASS — 13 tests passed (7 from Tasks 7-8 + 6 from this task)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/incidents.ts packages/cli/test/incidents.test.ts
git commit -m "Add looksLikeFixCommit heuristic and synthesizeIncident (claude -p by default)"
```

---

### Task 10: `runCaptureIncident` — the full pipeline

**Files:**
- Modify: `packages/cli/src/commands/incidents.ts`
- Test: `packages/cli/test/incidents.test.ts`

**Interfaces:**
- Consumes: `readIncidentsConfig` (Task 7), `looksLikeFixCommit`, `synthesizeIncident` (Task 9), `redactSecrets` from `@skilljit/core` (Task 2), `serializeIncidentMd` from `@skilljit/core` (Task 3).
- Produces: `HookPayload` type, `runCaptureIncident(payload: HookPayload, opts: CaptureIncidentOptions): Promise<{ captured: boolean; reason: string }>`, exported from `packages/cli/src/commands/incidents.ts`. Task 11 (bin.ts wiring) consumes both.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/incidents.test.ts`:

```ts
describe("runCaptureIncident", () => {
  let stateDir: string;
  let localClonePath: string;
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function makePayload(overrides: Partial<any> = {}) {
    return {
      session_id: "s1",
      transcript_path: "/tmp/does-not-need-to-exist-for-non-matching-tests.jsonl",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: `git commit -m "fix: checkout timeout"` },
      ...overrides,
    };
  }

  it("skips non-Bash tool calls", async () => {
    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(makePayload({ tool_name: "Write" }), { stateDir: "/unused" });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/not a bash/i);
  });

  it("skips commands that aren't fix-like git commits", async () => {
    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(
      makePayload({ tool_input: { command: "npm test" } }),
      { stateDir: "/unused" },
    );
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/fix/i);
  });

  it("skips when incidents aren't configured", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    const { runCaptureIncident } = await import("../src/commands/incidents.js");
    const result = await runCaptureIncident(makePayload(), { stateDir });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("captures, redacts, writes, commits, and pushes on a matching fix commit", async () => {
    const { execFileSync } = await import("node:child_process");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));

    // A bare remote to push to, and a persistent local clone (as
    // cmdIncidentsInit would create) pointed at it.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    localClonePath = path.join(stateDir, "incidents-write");
    execFileSync("git", ["clone", "-q", remote, localClonePath]);
    execFileSync("sh", ["-c", `cd '${localClonePath}' && git -c user.email=t@t.com -c user.name=t commit --allow-empty -q -m init`]);
    execFileSync("git", ["push", "-q"], { cwd: localClonePath });

    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: remote, localClonePath });

    // A source repo standing in for the codebase the fix was committed to.
    const codeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-code-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: codeRepo });
    fs.writeFileSync(path.join(codeRepo, "app.ts"), "// fixed\n");
    execFileSync("git", ["add", "-A"], { cwd: codeRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "fix: checkout timeout"],
      { cwd: codeRepo },
    );

    const transcriptPath = path.join(stateDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: "user", content: "checkout was timing out" }));

    const fakeSynthesize = async () =>
      JSON.stringify({
        symptom: "Checkout timed out under load.",
        investigation: "Ruled out the payment provider.",
        rootCause: "A migration held a lock on a hot table.",
        fix: "Reran with CREATE INDEX CONCURRENTLY.",
      });

    const result = await runCaptureIncident(makePayload({ cwd: codeRepo, transcript_path: transcriptPath }), {
      stateDir,
      synthesizeImpl: fakeSynthesize,
    });

    expect(result.captured).toBe(true);
    const files = fs.readdirSync(path.join(localClonePath, "incidents"));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(localClonePath, "incidents", files[0]), "utf8");
    expect(content).toContain("Checkout timed out under load");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(codeRepo, { recursive: true, force: true });
  });

  it("fails closed and writes nothing when the synthesized response has the wrong shape", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-capture-"));
    localClonePath = path.join(stateDir, "incidents-write");
    fs.mkdirSync(localClonePath, { recursive: true });
    const { writeIncidentsConfig, runCaptureIncident } = await import("../src/commands/incidents.js");
    writeIncidentsConfig(stateDir, { repoUrl: "unused", localClonePath });

    const transcriptPath = path.join(stateDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "x");

    // This exercises the synthesizeIncident shape-check fail-closed path
    // (Task 9), not redactSecrets's own fail-closed path — redactSecrets
    // catches internally and can't be made to throw through a realistic
    // string input, so its fail-closed behavior is unit-tested directly
    // in Task 2's redact.test.ts instead. Both are real fail-closed exits
    // from the same pipeline; this test covers the reachable one.
    const fakeSynthesize = async () => JSON.stringify({ symptom: 1, investigation: 2, rootCause: 3, fix: 4 });

    const result = await runCaptureIncident(makePayload({ transcript_path: transcriptPath, cwd: stateDir }), {
      stateDir,
      synthesizeImpl: fakeSynthesize,
    });

    expect(result.captured).toBe(false);
    expect(fs.existsSync(path.join(localClonePath, "incidents"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: FAIL — `runCaptureIncident is not a function`

- [ ] **Step 3: Write the implementation**

Add to `packages/cli/src/commands/incidents.ts`:

```ts
import { redactSecrets, serializeIncidentMd } from "@skilljit/core";

export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: { command?: string };
}

export interface CaptureIncidentOptions {
  stateDir: string;
  execFileImpl?: ExecFileFn;
  readFileImpl?: (filePath: string) => string;
  synthesizeImpl?: (prompt: string) => Promise<string>;
}

/**
 * The full capture pipeline, invoked by the installed PostToolUse hook.
 * Every early-exit path returns {captured: false, reason} rather than
 * throwing — a hook failing loudly would be disruptive mid-session for
 * something that's supposed to be invisible on the common case (an
 * ordinary commit that isn't a fix).
 */
export async function runCaptureIncident(
  payload: HookPayload,
  opts: CaptureIncidentOptions,
): Promise<{ captured: boolean; reason: string }> {
  if (payload.tool_name !== "Bash") {
    return { captured: false, reason: "not a Bash tool call" };
  }
  const command = payload.tool_input.command ?? "";
  if (!looksLikeFixCommit(command)) {
    return { captured: false, reason: "commit does not look like a fix" };
  }

  const config = readIncidentsConfig(opts.stateDir);
  if (!config) {
    return { captured: false, reason: "incidents not configured (run: skilljit incidents init <repo-url>)" };
  }

  const run: ExecFileFn = opts.execFileImpl ?? ((cmd, args) => execFileAsync(cmd, args));
  const readFile = opts.readFileImpl ?? ((p: string) => fs.readFileSync(p, "utf8"));

  const { stdout: shaOut } = await run("git", ["-C", payload.cwd, "rev-parse", "HEAD"]);
  const commitSha = shaOut.trim();
  const { stdout: diff } = await run("git", ["-C", payload.cwd, "show", commitSha]);
  const transcript = readFile(payload.transcript_path);

  let synthesized;
  try {
    synthesized = await synthesizeIncident(transcript, diff, opts.synthesizeImpl);
  } catch (err) {
    return { captured: false, reason: `synthesis failed: ${(err as Error).message}` };
  }

  const redactedFields = {
    symptom: redactSecrets(synthesized.symptom),
    investigation: redactSecrets(synthesized.investigation),
    rootCause: redactSecrets(synthesized.rootCause),
    fix: redactSecrets(synthesized.fix),
  };
  const allClean = Object.values(redactedFields).every((r) => r.clean);
  if (!allClean) {
    return { captured: false, reason: "redaction failed, needs manual review" };
  }

  const capturedAt = new Date().toISOString();
  const record = {
    symptom: redactedFields.symptom.text,
    investigation: redactedFields.investigation.text,
    rootCause: redactedFields.rootCause.text,
    fix: redactedFields.fix.text,
    commitSha,
    repo: `git:${config.repoUrl}`,
    capturedAt,
    verified: false,
  };

  await run("git", ["-C", config.localClonePath, "pull", "--quiet"]);
  const incidentsDir = path.join(config.localClonePath, "incidents");
  fs.mkdirSync(incidentsDir, { recursive: true });
  const filename = `${capturedAt.slice(0, 10)}-${commitSha.slice(0, 7)}.md`;
  fs.writeFileSync(path.join(incidentsDir, filename), serializeIncidentMd(record));

  await run("git", ["-C", config.localClonePath, "add", `incidents/${filename}`]);
  await run("git", [
    "-C",
    config.localClonePath,
    "-c",
    "user.email=skilljit@localhost",
    "-c",
    "user.name=skilljit",
    "commit",
    "-q",
    "-m",
    `incident: ${record.symptom.slice(0, 60)}`,
  ]);
  await run("git", ["-C", config.localClonePath, "push", "--quiet"]);

  return { captured: true, reason: "incident captured and pushed" };
}
```

Add the missing imports at the top of `packages/cli/src/commands/incidents.ts` (combine with existing ones from Tasks 7–9):

```ts
import type { ExecFileFn } from "@skilljit/core";
import { redactSecrets, serializeIncidentMd } from "@skilljit/core";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run test/incidents.test.ts`
Expected: PASS — 18 tests passed (13 from Tasks 7-9 + 5 from this task)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/incidents.ts packages/cli/test/incidents.test.ts
git commit -m "Add runCaptureIncident: the full fail-closed capture pipeline"
```

---

### Task 11: Wire `incidents init`/`install-hook`/`capture-incident` into the CLI, and into `sync`

**Files:**
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/commands/sync.ts`
- Test: `packages/cli/test/sync.test.ts`

**Interfaces:**
- Consumes: everything from `packages/cli/src/commands/incidents.ts` (Tasks 7–10); `ingestIncidentsFromGitRepo` from `@skilljit/core` (Task 6).
- Produces: three new `commander` subcommands under `incidents`, plus a hidden top-level `capture-incident` command; `runSync` additionally ingests the configured incidents repo when one exists.

- [ ] **Step 1: Write the failing test for sync's incidents integration**

Add to `packages/cli/test/sync.test.ts`:

```ts
import { writeIncidentsConfig } from "../src/commands/incidents.js";

// ... (inside the existing describe("runSync", ...) block, add:)

  it("also ingests a configured incidents repo, into the same catalog", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-"));
    const dbPath = path.join(dir, "catalog.db");
    const stateDir = path.join(dir, "state");

    const { execFileSync } = await import("node:child_process");
    const incidentsRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-cli-incidents-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: incidentsRepo });
    fs.mkdirSync(path.join(incidentsRepo, "incidents"));
    const { serializeIncidentMd } = await import("@skilljit/core");
    fs.writeFileSync(
      path.join(incidentsRepo, "incidents", "2026-08-24-a1b2c3d.md"),
      serializeIncidentMd({
        symptom: "Checkout timed out.",
        investigation: "x",
        rootCause: "y",
        fix: "z",
        commitSha: "a1b2c3d4",
        repo: `git:${incidentsRepo}`,
        capturedAt: "2026-08-24T00:00:00.000Z",
        verified: false,
      }),
    );
    execFileSync("git", ["add", "-A"], { cwd: incidentsRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add incident"],
      { cwd: incidentsRepo },
    );
    writeIncidentsConfig(stateDir, { repoUrl: incidentsRepo, localClonePath: incidentsRepo });

    const result = await runSync({ dbPath, sources: [], stateDir, log: () => {} });
    expect(result.incidentsIngested).toBe(1);

    const { Catalog } = await import("@skilljit/core");
    const catalog = new Catalog(dbPath);
    expect(catalog.incidentCount()).toBe(1);
    catalog.close();

    fs.rmSync(incidentsRepo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run test/sync.test.ts`
Expected: FAIL — `result.incidentsIngested` is `undefined` (or `runSync` errors on the unrecognized `stateDir` option, depending on how strictly the test asserts)

- [ ] **Step 3: Wire incidents into `runSync`**

In `packages/cli/src/commands/sync.ts`, add to the imports:

```ts
import { ingestIncidentsFromGitRepo } from "@skilljit/core";
import { readIncidentsConfig } from "./incidents.js";
```

Add `stateDir?: string;` to `SyncOptions` and `incidentsIngested: number;` to `SyncResult`. At the end of `runSync`'s try block (after the existing `gitSources` loop, before `return { total: ... }`), add:

```ts
    let incidentsIngested = 0;
    if (opts.stateDir) {
      const incidentsConfig = readIncidentsConfig(opts.stateDir);
      if (incidentsConfig) {
        log(`syncing incidents from ${incidentsConfig.repoUrl} ...`);
        try {
          const incidents = await ingestIncidentsFromGitRepo(incidentsConfig.repoUrl, {
            execFileImpl: opts.execFileImpl,
          });
          catalog.upsertIncidents(incidents);
          incidentsIngested = incidents.length;
          log(`  ${incidents.length} incident(s) found`);
        } catch (err) {
          log(`  failed to sync incidents: ${(err as Error).message}`);
        }
      }
    }
```

Update the final `return` statement to include `incidentsIngested`:

```ts
    return { total: catalog.count(), perSource, failedSources, perGitSource, failedGitSources, incidentsIngested };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run test/sync.test.ts`
Expected: PASS — all sync tests including the new one

- [ ] **Step 5: Wire the CLI subcommands in `bin.ts`**

In `packages/cli/src/bin.ts`, add to the imports:

```ts
import { cmdIncidentsInit, cmdIncidentsInstallHook, runCaptureIncident } from "./commands/incidents.js";
```

`defaultStateDir` is not re-imported here — `bin.ts` already imports it from `./commands/proxy.js` (`import { defaultStateDir, cmdInit, cmdAdopt, cmdRestore, cmdDoctor } from "./commands/proxy.js";`); reuse that existing binding for all three new commands below.

Add these commands, near the existing `program.command("sync")` ... `program.command("doctor")` block:

```ts
const incidentsCmd = program.command("incidents").description("Capture and share debugging context across a team");

incidentsCmd
  .command("init <repoUrl>")
  .description("Configure the git repo incidents are captured to and synced from")
  .action(async (repoUrl: string) => {
    await cmdIncidentsInit({ repoUrl, stateDir: defaultStateDir() }, (l) => console.log(l));
  });

incidentsCmd
  .command("install-hook")
  .description("Install the PostToolUse hook that captures incidents on fix-like git commits")
  .option("--yes", "actually write the change (otherwise this is a dry run)")
  .option("--settings-path <path>", "settings.json path", path.join(os.homedir(), ".claude", "settings.json"))
  .action(async (options: { yes?: boolean; settingsPath: string }) => {
    await cmdIncidentsInstallHook({ settingsPath: options.settingsPath, yes: options.yes }, (l) => console.log(l));
  });

program
  .command("capture-incident")
  .description("Internal: invoked by the PostToolUse hook, reads its JSON payload from stdin")
  .action(async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await runCaptureIncident(payload, { stateDir: defaultStateDir() });
    if (result.captured) console.log(`skilljit: ${result.reason}`);
  });
```

Add `import path from "node:path";` and `import os from "node:os";` to the top of `bin.ts` if not already present (check first — `defaultStateDir` in `proxy.ts` already needs both, but `bin.ts` itself may not import them yet).

Update the `sync` command's `.action(...)` in `bin.ts` to pass `stateDir` through:

```ts
    const result = await runSync({
      dbPath: options.db,
      sources,
      gitSources: options.git,
      token: options.token,
      stateDir: defaultStateDir(),
      log: (l) => console.log(l),
    });
```

- [ ] **Step 6: Build to confirm no type errors**

Run: `cd /Users/mudassirsiddiqui/Downloads/skilljit && npm run build`
Expected: exits 0 across all four packages

- [ ] **Step 7: Run the full test suite**

Run: `cd /Users/mudassirsiddiqui/Downloads/skilljit && npm run test --workspaces --if-present`
Expected: PASS — all existing tests plus every test added in Tasks 1–11

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/bin.ts packages/cli/src/commands/sync.ts packages/cli/test/sync.test.ts
git commit -m "Wire incidents init/install-hook/capture-incident into the CLI, and into sync"
```

---

### Task 12: `incident_find`/`incident_load` MCP tools

**Files:**
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/server.ts`'s `CreateServerOptions` interface (same file)
- Test: `packages/mcp/test/server-incidents.test.ts`

**Interfaces:**
- Consumes: `Catalog.searchIncidents`/`getIncident` (Task 4).
- Produces: `CreateServerOptions.incidentsCatalogPath?: string`, and the two new tools, registered only when that option is set.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/test/server-incidents.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Catalog } from "@skilljit/core";
import { createServer } from "../src/server.js";

describe("skilljit MCP server — incidents", () => {
  let dbPath: string;
  let dir: string;
  let client: Client;
  let handle: ReturnType<typeof createServer>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-incidents-"));
    dbPath = path.join(dir, "catalog.db");
    const seed = new Catalog(dbPath);
    seed.upsertIncidents([
      {
        id: "git:acme/webapp/incidents/a1b2c3d",
        symptom: "Checkout requests time out under load after a deploy.",
        investigation: "Ruled out the payment provider. Traced it to a migration holding a lock.",
        rootCause: "ACCESS EXCLUSIVE lock on a hot table.",
        fix: "Reran the migration with CREATE INDEX CONCURRENTLY.",
        commitSha: "a1b2c3d4e5f6",
        repo: "git:git@example.com:acme/webapp.git",
        capturedAt: "2026-08-24T12:00:00.000Z",
        verified: false,
      },
    ]);
    seed.close();

    handle = createServer({ catalogPath: dbPath, incidentsCatalogPath: dbPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    handle.catalog.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes incident_find and incident_load when incidents are configured", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("incident_find");
    expect(names).toContain("incident_load");
  });

  it("incident_find returns cheap candidates without investigation/fix", async () => {
    const result = await client.callTool({ name: "incident_find", arguments: { symptom: "checkout timeout" } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("a1b2c3d");
    expect(text).not.toContain("CREATE INDEX CONCURRENTLY");
  });

  it("incident_load returns the full record and warns it's unverified", async () => {
    const result = await client.callTool({
      name: "incident_load",
      arguments: { id: "git:acme/webapp/incidents/a1b2c3d" },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain("CREATE INDEX CONCURRENTLY");
    expect(text).toContain("not been reviewed by a human");
  });

  it("incident_load reports a clean error for an unknown id", async () => {
    const result = await client.callTool({ name: "incident_load", arguments: { id: "nope/nope" } });
    expect(result.isError).toBe(true);
  });
});

describe("skilljit MCP server without incidents configured", () => {
  it("does not expose incident_find/incident_load", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljit-mcp-no-incidents-"));
    const dbPath = path.join(dir, "catalog.db");
    new Catalog(dbPath).close();

    const handle = createServer({ catalogPath: dbPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("incident_find");

    await client.close();
    handle.catalog.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/mcp && npx vitest run test/server-incidents.test.ts`
Expected: FAIL — `createServer` doesn't accept `incidentsCatalogPath`, and `incident_find`/`incident_load` don't exist

- [ ] **Step 3: Write the implementation**

In `packages/mcp/src/server.ts`, add `incidentsCatalogPath?: string;` to `CreateServerOptions`, with a comment:

```ts
  /** Path to a catalog db containing captured incidents. Enables
   * incident_find/incident_load — omit to leave the tool surface
   * unchanged for users who haven't opted into incident capture. */
  incidentsCatalogPath?: string;
```

Add this block after the `skill_read_file` tool registration and before the `upstreams`/`tool_find`/`tool_call` block:

```ts
  if (opts.incidentsCatalogPath) {
    const incidentsCatalog = opts.incidentsCatalogPath === opts.catalogPath ? catalog : new Catalog(opts.incidentsCatalogPath);

    server.registerTool(
      "incident_find",
      {
        title: "Find past incidents",
        description:
          "Search captured debugging incidents for one matching a symptom you're investigating, without " +
          "loading the full investigation. Returns cheap candidates (id, symptom, root cause, verified status) " +
          "— call incident_load on the one you want the full context for.",
        inputSchema: {
          symptom: z.string().describe("What you're observing, in your own words."),
          limit: z.number().int().positive().max(50).optional().describe("Max candidates to return (default 8)."),
        },
      },
      async ({ symptom, limit }: { symptom: string; limit?: number }) => {
        const hits = incidentsCatalog.searchIncidents(symptom, limit ?? 8);
        const payload = JSON.stringify(
          hits.map((h) => ({
            id: h.incident.id,
            symptom: h.incident.symptom,
            rootCause: h.incident.rootCause,
            capturedAt: h.incident.capturedAt,
            verified: h.incident.verified,
          })),
          null,
          2,
        );
        recordActual("incident_find", payload);
        return { content: [{ type: "text" as const, text: payload }] };
      },
    );

    server.registerTool(
      "incident_load",
      {
        title: "Load a past incident's full context",
        description:
          "Load the full investigation, root cause, and fix for one incident by its id, as returned by " +
          "incident_find. This is the point where a teammate's prior debugging context enters yours.",
        inputSchema: {
          id: z.string().describe("The incident id, exactly as returned by incident_find."),
        },
      },
      async ({ id }: { id: string }) => {
        const incident = incidentsCatalog.getIncident(id);
        if (!incident) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `No incident found with id "${id}". Call incident_find first.` }],
          };
        }
        let text = `## Symptom\n${incident.symptom}\n\n## Investigation\n${incident.investigation}\n\n## Root cause\n${incident.rootCause}\n\n## Fix\n${incident.fix}`;
        if (!incident.verified) {
          text = `⚠️ This incident was auto-captured and hasn't been reviewed by a human. Verify before trusting it fully.\n\n${text}`;
        }
        recordActual("incident_load", text);
        return { content: [{ type: "text" as const, text }] };
      },
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mcp && npx vitest run test/server-incidents.test.ts`
Expected: PASS — 5 tests passed

- [ ] **Step 5: Run the full mcp test suite to confirm no regressions**

Run: `cd packages/mcp && npx vitest run`
Expected: PASS — all existing server/server-proxy tests plus the new server-incidents tests

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/server.ts packages/mcp/test/server-incidents.test.ts
git commit -m "Add opt-in incident_find/incident_load MCP tools"
```

---

### Task 13: Wire incidents into `skilljit serve`, full-repo verification

**Files:**
- Modify: `packages/cli/src/bin.ts`
- Test: none new (this is wiring + a manual smoke check)

**Interfaces:**
- Consumes: `readIncidentsConfig` (Task 7), `createServer`'s `incidentsCatalogPath` option (Task 12).

- [ ] **Step 1: Wire `serve` to pass the incidents catalog path**

In `packages/cli/src/bin.ts`, update the `serve` command's `.action(...)`:

```ts
program
  .command("serve")
  .description("Run the skilljit MCP stdio server (this is what your MCP client config should launch)")
  .option("--db <path>", "catalog db path", defaultCatalogPath())
  .option("--config <path>", "MCP client config previously passed to `skilljit adopt`, to enable tool_find/tool_call")
  .action(async (options: { db: string; config?: string }) => {
    let upstreams;
    if (options.config) {
      const record = latestAdoption(defaultStateDir(), options.config);
      if (record) upstreams = resolveManagedUpstreams(record);
    }
    const incidentsConfig = readIncidentsConfig(defaultStateDir());
    const { server } = createServer({
      catalogPath: options.db,
      upstreams,
      incidentsCatalogPath: incidentsConfig ? options.db : undefined,
    });
    await server.connect(new StdioServerTransport());
  });
```

(Incidents are ingested into the same catalog db as skills via `sync`, per Task 11 — so `incidentsCatalogPath` is just `options.db` again when incidents are configured, not a separate file. This matches Task 12's `opts.incidentsCatalogPath === opts.catalogPath ? catalog : new Catalog(...)` guard, which avoids opening the same db file twice in this case.)

- [ ] **Step 2: Build the whole monorepo**

Run: `cd /Users/mudassirsiddiqui/Downloads/skilljit && npm run build`
Expected: exits 0 across all four packages

- [ ] **Step 3: Run the complete test suite**

Run: `cd /Users/mudassirsiddiqui/Downloads/skilljit && npm run test --workspaces --if-present`
Expected: PASS — every test across all four packages, including every test added in Tasks 1–13

- [ ] **Step 4: Manual end-to-end smoke test**

```bash
cd /tmp && mkdir skilljit-incidents-smoke && cd skilljit-incidents-smoke
git init -q -b main incidents-repo
node /Users/mudassirsiddiqui/Downloads/skilljit/packages/cli/dist/bin.js incidents init "$(pwd)/incidents-repo"
node /Users/mudassirsiddiqui/Downloads/skilljit/packages/cli/dist/bin.js incidents install-hook
node /Users/mudassirsiddiqui/Downloads/skilljit/packages/cli/dist/bin.js incidents install-hook --yes
cat ~/.claude/settings.json | grep -A3 capture-incident
```

Expected: `incidents init` prints "Incidents repo configured"; the first `install-hook` prints a dry-run diff; the second (with `--yes`) writes the hook and the final `cat`/`grep` shows the `skilljit capture-incident` command present in `~/.claude/settings.json`.

Clean up afterward: remove the `PostToolUse` entry this added to `~/.claude/settings.json` by hand (or restore from a backup) if this smoke test is run on a real development machine rather than a disposable one — this step genuinely modifies that file.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/bin.ts
git commit -m "Wire incidents into skilljit serve"
```

---

## Self-review notes

- **Spec coverage**: data model (Task 1, 3), capture pipeline (Tasks 7-11), setup commands (Tasks 7-8), redaction/fail-closed (Task 2, applied in Task 10), MCP tools (Task 12), distribution via existing sync (Tasks 5-6, 11) — every spec section has a task.
- **Type consistency checked**: `IncidentRecord`/`IncidentSearchHit` (Task 1) used identically in catalog methods (Task 4), `incident-md.ts` (Task 3), `incidents-git.ts` (Task 6), and `server.ts` (Task 12). `ExecFileFn` reused from `@skilljit/core` throughout rather than redefined. `IncidentsConfig` shape (Task 7) consumed identically by Tasks 9-11.
- **Placeholder scan**: no TBD/TODO markers; every step has runnable code.
