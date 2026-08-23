import { Catalog } from "@skilljit/core";
import type { SkillSearchHit } from "@skilljit/core";

export interface SearchOptions {
  dbPath: string;
  query: string;
  limit?: number;
}

export function runSearch(opts: SearchOptions): SkillSearchHit[] {
  const catalog = new Catalog(opts.dbPath);
  try {
    return catalog.searchSkills(opts.query, opts.limit ?? 8);
  } finally {
    catalog.close();
  }
}

export function formatSearchResults(hits: SkillSearchHit[]): string {
  if (hits.length === 0) return "No matching skills found.";
  return hits
    .map((h, i) => {
      const audit = h.skill.auditStatus && h.skill.auditStatus !== "unaudited" ? ` [audit: ${h.skill.auditStatus}]` : "";
      return `${i + 1}. ${h.skill.name} (${h.skill.source})${audit}\n   ${h.skill.description}`;
    })
    .join("\n");
}
