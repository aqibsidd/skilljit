import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { SkillRecord, SkillSearchHit, ToolRecord, ToolSearchHit } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
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
  }

  close(): void {
    this.db.close();
  }

  // ---- Skills ----------------------------------------------------------

  upsertSkills(skills: SkillRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO skills (id, name, source, description, body, install_count, audit_status, updated_at)
      VALUES (@id, @name, @source, @description, @body, @installCount, @auditStatus, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        source = excluded.source,
        description = excluded.description,
        body = excluded.body,
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
}

function rowToSkill(row: any): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    description: row.description,
    body: row.body,
    installCount: row.install_count ?? undefined,
    auditStatus: row.audit_status ?? "unaudited",
    updatedAt: row.updated_at,
  };
}
