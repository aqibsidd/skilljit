import { Catalog, ingestGithubRepo, DEFAULT_GITHUB_SOURCES } from "@skilljit/core";

export interface SyncOptions {
  dbPath: string;
  sources?: { owner: string; repo: string }[];
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface SyncResult {
  total: number;
  perSource: { owner: string; repo: string; count: number }[];
  failedSources: { owner: string; repo: string }[];
}

/**
 * Ingest every configured GitHub source into the local catalog db.
 * One source failing (network error, rate limit, repo renamed) does not
 * abort the rest — skilljit's catalog should degrade gracefully, not
 * die because one upstream repo is briefly unavailable.
 */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const sources = opts.sources ?? DEFAULT_GITHUB_SOURCES;
  const catalog = new Catalog(opts.dbPath);
  const perSource: SyncResult["perSource"] = [];
  const failedSources: SyncResult["failedSources"] = [];

  try {
    for (const { owner, repo } of sources) {
      log(`syncing github:${owner}/${repo} ...`);
      try {
        const skills = await ingestGithubRepo(owner, repo, { fetchImpl: opts.fetchImpl });
        catalog.upsertSkills(skills);
        perSource.push({ owner, repo, count: skills.length });
        log(`  ${skills.length} skill(s) found`);
      } catch (err) {
        failedSources.push({ owner, repo });
        log(`  failed: ${(err as Error).message}`);
      }
    }
    return { total: catalog.count(), perSource, failedSources };
  } finally {
    catalog.close();
  }
}
