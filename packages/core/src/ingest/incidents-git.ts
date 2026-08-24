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
