import { Catalog, ingestGithubRepo, ingestLocalGitRepo, DEFAULT_GITHUB_SOURCES } from "@skilljit/core";
import type { ExecFileFn } from "@skilljit/core";

export interface SyncOptions {
  dbPath: string;
  sources?: { owner: string; repo: string }[];
  /** Arbitrary git remotes (self-hosted, GitLab, SSH-authenticated private
   * repos, ...), ingested via clone + git worktree instead of the GitHub API. */
  gitSources?: string[];
  /** Where gitSources' bare mirror clones are cached. Defaults to
   * ~/.skilljit/git-cache. */
  gitCacheDir?: string;
  /** GitHub token for the sources above (or set SKILLJIT_GITHUB_TOKEN). */
  token?: string;
  fetchImpl?: typeof fetch;
  execFileImpl?: ExecFileFn;
  log?: (line: string) => void;
}

export interface SyncResult {
  total: number;
  perSource: { owner: string; repo: string; count: number }[];
  failedSources: { owner: string; repo: string }[];
  perGitSource: { url: string; count: number }[];
  failedGitSources: { url: string }[];
}

/**
 * Ingest every configured GitHub source and git remote into the local
 * catalog db. One source failing (network error, rate limit, repo renamed,
 * bad SSH auth) does not abort the rest — skilljit's catalog should
 * degrade gracefully, not die because one upstream repo is briefly
 * unavailable.
 */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const sources = opts.sources ?? DEFAULT_GITHUB_SOURCES;
  const gitSources = opts.gitSources ?? [];
  const catalog = new Catalog(opts.dbPath);
  const perSource: SyncResult["perSource"] = [];
  const failedSources: SyncResult["failedSources"] = [];
  const perGitSource: SyncResult["perGitSource"] = [];
  const failedGitSources: SyncResult["failedGitSources"] = [];

  try {
    for (const { owner, repo } of sources) {
      log(`syncing github:${owner}/${repo} ...`);
      try {
        const skills = await ingestGithubRepo(owner, repo, { fetchImpl: opts.fetchImpl, token: opts.token });
        catalog.upsertSkills(skills);
        perSource.push({ owner, repo, count: skills.length });
        log(`  ${skills.length} skill(s) found`);
      } catch (err) {
        failedSources.push({ owner, repo });
        log(`  failed: ${(err as Error).message}`);
      }
    }
    for (const url of gitSources) {
      log(`syncing ${url} (git worktree) ...`);
      try {
        const skills = await ingestLocalGitRepo(url, { execFileImpl: opts.execFileImpl, cacheDir: opts.gitCacheDir });
        catalog.upsertSkills(skills);
        perGitSource.push({ url, count: skills.length });
        log(`  ${skills.length} skill(s) found`);
      } catch (err) {
        failedGitSources.push({ url });
        log(`  failed: ${(err as Error).message}`);
      }
    }
    return { total: catalog.count(), perSource, failedSources, perGitSource, failedGitSources };
  } finally {
    catalog.close();
  }
}
