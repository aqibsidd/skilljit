import YAML from "yaml";
import type { SkillRecord } from "../types.js";

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const RESERVED_WORDS = ["anthropic", "claude"];
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParseContext {
  /** e.g. "github:anthropics/skills" */
  source: string;
  /** repo-relative path to the SKILL.md file, used to build a stable id */
  path: string;
  now?: () => string;
}

/**
 * Parse a SKILL.md file's content into a SkillRecord, enforcing the same
 * frontmatter constraints Anthropic's Agent Skills spec requires (max
 * lengths, allowed name charset, no reserved words, no XML tags). A file
 * that doesn't satisfy the spec is skipped (returns null) rather than
 * ingested malformed — a bad upstream skill should disappear quietly, not
 * corrupt the local catalog.
 */
export function parseSkillMd(content: string, ctx: ParseContext): SkillRecord | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;

  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1]);
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== "object") return null;

  const { name, description } = frontmatter as Record<string, unknown>;
  if (typeof name !== "string" || typeof description !== "string") return null;
  if (!NAME_RE.test(name)) return null;
  if (RESERVED_WORDS.some((w) => name.includes(w))) return null;
  if (description.length === 0 || description.length > 1024) return null;
  if (/<[^>]+>/.test(name) || /<[^>]+>/.test(description)) return null;

  const body = match[2] ?? "";
  const dir = ctx.path.replace(/\/SKILL\.md$/i, "").replace(/^\.\//, "");
  const id = dir && dir !== ctx.path ? `${ctx.source}/${dir}` : `${ctx.source}/${name}`;

  return {
    id,
    name,
    source: ctx.source,
    description,
    body,
    updatedAt: (ctx.now ?? (() => new Date().toISOString()))(),
  };
}
