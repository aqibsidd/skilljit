/** A bundled non-SKILL.md file (e.g. a reference doc or helper script)
 * living alongside a skill in its source directory. Path is relative to
 * the skill's own directory, e.g. "references/foo.md". */
export interface SkillFile {
  path: string;
  content: string;
}

/** A single skill record as stored in the local catalog. */
export interface SkillRecord {
  /** Stable unique id, e.g. "vercel-labs/agent-skills/pdf-processing". */
  id: string;
  /** Short name from SKILL.md frontmatter, e.g. "pdf-processing". */
  name: string;
  /** Where this skill came from, e.g. "github:vercel-labs/agent-skills". */
  source: string;
  /** The `description` field from SKILL.md frontmatter. */
  description: string;
  /** Full SKILL.md body (Level 2 content), loaded lazily by consumers. */
  body: string;
  /** Bundled reference docs / scripts from the skill's directory, loaded
   * lazily via skill_read_file — never eagerly returned by skill_load. */
  files?: SkillFile[];
  /** Optional install-count / popularity signal from the upstream registry. */
  installCount?: number;
  /** Audit status surfaced by the upstream registry, if any. */
  auditStatus?: "pass" | "warn" | "fail" | "unaudited";
  /** ISO timestamp of when this record was last refreshed. */
  updatedAt: string;
}

/** A search hit: a skill plus its relevance rank (lower = more relevant). */
export interface SkillSearchHit {
  skill: Omit<SkillRecord, "body" | "files">;
  rank: number;
}

/** An MCP upstream tool schema as cataloged for tool_find/tool_call routing. */
export interface ToolRecord {
  id: string;
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  updatedAt: string;
}

export interface ToolSearchHit {
  tool: ToolRecord;
  rank: number;
}

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
  /** The code repo this incident is about — its `origin` remote URL. Pairs
   * with commitSha to point at the actual fix (not the separate repo
   * incidents get distributed through). */
  repo: string;
  filesTouched?: string[];
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** False until a human confirms this auto-captured record is accurate. */
  verified: boolean;
  /** True once someone has retracted this incident (`skilljit incidents
   * revoke`) — e.g. it turned out wrong, or it leaked something it
   * shouldn't have. Kept, not deleted: incident_find excludes revoked
   * records from results, and incident_load refuses to return a revoked
   * record's content. */
  revoked: boolean;
  /** Why it was revoked, if given. Only meaningful when revoked is true. */
  revokedReason?: string;
}

/** A search hit: an incident plus its relevance rank (lower = more relevant). */
export interface IncidentSearchHit {
  incident: Omit<IncidentRecord, "investigation" | "fix">;
  rank: number;
}
