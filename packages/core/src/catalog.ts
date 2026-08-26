import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  SkillRecord,
  SkillSearchHit,
  ToolRecord,
  ToolSearchHit,
  IncidentRecord,
  IncidentSearchHit,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
  files_json    TEXT,
  install_count INTEGER,
  audit_status  TEXT,
  updated_at    TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS ledger_totals (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  baseline_tokens INTEGER NOT NULL DEFAULT 0,
  actual_tokens   INTEGER NOT NULL DEFAULT 0,
  session_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tools (
  id            TEXT PRIMARY KEY,
  server        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  input_schema  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  tokenize = 'porter unicode61'
);

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
  verified     INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0,
  revoked_reason TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(
  id UNINDEXED,
  symptom,
  tokenize = 'porter unicode61'
);
`;

/**
 * Turn a free-text query into a permissive FTS5 MATCH expression:
 * each alphanumeric token, quoted (so hyphens/punctuation in the raw
 * query can't break MATCH syntax) and OR'd together. OR-recall is
 * intentional: skill_find/tool_find return cheap candidates, and the
 * caller (Claude) can re-query in different words if the first list
 * doesn't have what it needs — that beats forcing one-shot precision
 * out of a token search.
 */
function toFtsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => t.length > 0);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export class Catalog {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive, idempotent schema migrations for catalogs created by older
   * skilljit versions — CREATE TABLE IF NOT EXISTS only runs for a table
   * that doesn't exist yet, so a pre-existing catalog.db needs this to
   * pick up new columns. */
  private migrate(): void {
    const columns = this.db.prepare(`PRAGMA table_info(skills)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "files_json")) {
      this.db.exec(`ALTER TABLE skills ADD COLUMN files_json TEXT`);
    }
    const incidentColumns = this.db.prepare(`PRAGMA table_info(incidents)`).all() as { name: string }[];
    if (!incidentColumns.some((c) => c.name === "revoked")) {
      this.db.exec(`ALTER TABLE incidents ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`);
    }
    if (!incidentColumns.some((c) => c.name === "revoked_reason")) {
      this.db.exec(`ALTER TABLE incidents ADD COLUMN revoked_reason TEXT`);
    }
    this.db.exec(
      `INSERT OR IGNORE INTO ledger_totals (id, baseline_tokens, actual_tokens, session_count) VALUES (1, 0, 0, 0)`,
    );
  }

  close(): void {
    this.db.close();
  }

  // ---- Skills ----------------------------------------------------------

  upsertSkills(skills: SkillRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO skills (id, name, source, description, body, files_json, install_count, audit_status, updated_at)
      VALUES (@id, @name, @source, @description, @body, @filesJson, @installCount, @auditStatus, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        source = excluded.source,
        description = excluded.description,
        body = excluded.body,
        files_json = excluded.files_json,
        install_count = excluded.install_count,
        audit_status = excluded.audit_status,
        updated_at = excluded.updated_at
    `);
    const deleteFts = this.db.prepare(`DELETE FROM skills_fts WHERE id = ?`);
    const insertFts = this.db.prepare(`INSERT INTO skills_fts (id, name, description) VALUES (?, ?, ?)`);

    const tx = this.db.transaction((rows: SkillRecord[]) => {
      for (const s of rows) {
        upsert.run({
          id: s.id,
          name: s.name,
          source: s.source,
          description: s.description,
          body: s.body,
          filesJson: s.files && s.files.length > 0 ? JSON.stringify(s.files) : null,
          installCount: s.installCount ?? null,
          auditStatus: s.auditStatus ?? "unaudited",
          updatedAt: s.updatedAt,
        });
        deleteFts.run(s.id);
        insertFts.run(s.id, s.name, s.description);
      }
    });
    tx(skills);
  }

  getSkill(id: string): SkillRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    return rowToSkill(row);
  }

  searchSkills(query: string, limit = 8): SkillSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `
        SELECT s.id, s.name, s.source, s.description, s.install_count, s.audit_status, s.updated_at,
               bm25(skills_fts) AS rank
        FROM skills_fts
        JOIN skills s ON s.id = skills_fts.id
        WHERE skills_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(ftsQuery, limit) as any[];
    return rows.map((row) => ({
      skill: {
        id: row.id,
        name: row.name,
        source: row.source,
        description: row.description,
        installCount: row.install_count ?? undefined,
        auditStatus: row.audit_status ?? "unaudited",
        updatedAt: row.updated_at,
      },
      rank: row.rank,
    }));
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM skills`).get() as { c: number };
    return row.c;
  }

  /** Name + description for every cataloged skill — used to compute the
   * "what this would have cost every turn" baseline without paying to
   * load every skill's full body. */
  listSkillMeta(): Pick<SkillRecord, "name" | "description">[] {
    return this.db.prepare(`SELECT name, description FROM skills`).all() as Pick<
      SkillRecord,
      "name" | "description"
    >[];
  }

  // ---- Tools -------------------------------------------------------------

  upsertTools(tools: ToolRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO tools (id, server, name, description, input_schema, updated_at)
      VALUES (@id, @server, @name, @description, @inputSchema, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        server = excluded.server,
        name = excluded.name,
        description = excluded.description,
        input_schema = excluded.input_schema,
        updated_at = excluded.updated_at
    `);
    const deleteFts = this.db.prepare(`DELETE FROM tools_fts WHERE id = ?`);
    const insertFts = this.db.prepare(`INSERT INTO tools_fts (id, name, description) VALUES (?, ?, ?)`);

    const tx = this.db.transaction((rows: ToolRecord[]) => {
      for (const t of rows) {
        upsert.run({
          id: t.id,
          server: t.server,
          name: t.name,
          description: t.description,
          inputSchema: JSON.stringify(t.inputSchema),
          updatedAt: t.updatedAt,
        });
        deleteFts.run(t.id);
        insertFts.run(t.id, t.name, t.description);
      }
    });
    tx(tools);
  }

  searchTools(query: string, limit = 8): ToolSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `
        SELECT t.id, t.server, t.name, t.description, t.input_schema, t.updated_at,
               bm25(tools_fts) AS rank
        FROM tools_fts
        JOIN tools t ON t.id = tools_fts.id
        WHERE tools_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(ftsQuery, limit) as any[];
    return rows.map((row) => ({
      tool: {
        id: row.id,
        server: row.server,
        name: row.name,
        description: row.description,
        inputSchema: JSON.parse(row.input_schema),
        updatedAt: row.updated_at,
      },
      rank: row.rank,
    }));
  }

  removeToolsForServer(server: string): void {
    const ids = this.db.prepare(`SELECT id FROM tools WHERE server = ?`).all(server) as { id: string }[];
    const deleteTool = this.db.prepare(`DELETE FROM tools WHERE id = ?`);
    const deleteFts = this.db.prepare(`DELETE FROM tools_fts WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const { id } of ids) {
        deleteTool.run(id);
        deleteFts.run(id);
      }
    });
    tx();
  }

  toolCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM tools`).get() as { c: number };
    return row.c;
  }

  // ---- Incidents -----------------------------------------------------

  upsertIncidents(incidents: IncidentRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO incidents (id, symptom, investigation, root_cause, fix, commit_sha, repo, files_touched, captured_at, verified, revoked, revoked_reason)
      VALUES (@id, @symptom, @investigation, @rootCause, @fix, @commitSha, @repo, @filesTouched, @capturedAt, @verified, @revoked, @revokedReason)
      ON CONFLICT(id) DO UPDATE SET
        symptom = excluded.symptom,
        investigation = excluded.investigation,
        root_cause = excluded.root_cause,
        fix = excluded.fix,
        commit_sha = excluded.commit_sha,
        repo = excluded.repo,
        files_touched = excluded.files_touched,
        captured_at = excluded.captured_at,
        verified = excluded.verified,
        revoked = excluded.revoked,
        revoked_reason = excluded.revoked_reason
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
          revoked: inc.revoked ? 1 : 0,
          revokedReason: inc.revokedReason ?? null,
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
        WHERE incidents_fts MATCH ? AND i.revoked = 0
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
        revoked: false,
      } as Omit<IncidentRecord, "investigation" | "fix">,
      rank: row.rank,
    }));
  }

  incidentCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM incidents`).get() as { c: number };
    return row.c;
  }

  // ---- Cross-session token ledger ----------------------------------------
  // Every skilljit session/tab shares this catalog.db, so these totals
  // accumulate across all of them — the fix for "N tabs open means N tabs
  // each independently paying the traditional baseline cost."

  /** Adds to the all-time baseline total and counts one more session. */
  addGlobalLedgerBaseline(deltaTokens: number): void {
    if (deltaTokens === 0) return;
    this.db
      .prepare(`UPDATE ledger_totals SET baseline_tokens = baseline_tokens + ? WHERE id = 1`)
      .run(deltaTokens);
  }

  addGlobalLedgerActual(deltaTokens: number): void {
    if (deltaTokens === 0) return;
    this.db.prepare(`UPDATE ledger_totals SET actual_tokens = actual_tokens + ? WHERE id = 1`).run(deltaTokens);
  }

  /** Call once per server startup — this is what makes sessionCount count tabs. */
  recordGlobalSessionStart(): void {
    this.db.exec(`UPDATE ledger_totals SET session_count = session_count + 1 WHERE id = 1`);
  }

  getGlobalLedgerTotals(): { baselineTokens: number; actualTokens: number; sessionCount: number } {
    const row = this.db
      .prepare(`SELECT baseline_tokens, actual_tokens, session_count FROM ledger_totals WHERE id = 1`)
      .get() as { baseline_tokens: number; actual_tokens: number; session_count: number };
    return {
      baselineTokens: row.baseline_tokens,
      actualTokens: row.actual_tokens,
      sessionCount: row.session_count,
    };
  }
}

function rowToSkill(row: any): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    description: row.description,
    body: row.body,
    files: row.files_json ? JSON.parse(row.files_json) : undefined,
    installCount: row.install_count ?? undefined,
    auditStatus: row.audit_status ?? "unaudited",
    updatedAt: row.updated_at,
  };
}

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
    revoked: !!row.revoked,
    revokedReason: row.revoked_reason ?? undefined,
  };
}
