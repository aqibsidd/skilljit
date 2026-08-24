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
