import { parseSkillMd } from "./parse.js";
import type { SkillRecord } from "../types.js";

export interface GithubIngestOptions {
  /** Injectable for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Personal access token (or SKILLJIT_GITHUB_TOKEN env var) for the 5000/hr rate limit. */
  token?: string;
  /** Override branch/ref instead of the repo's default branch. */
  ref?: string;
}

async function githubApiFetch(url: string, opts: GithubIngestOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token ?? process.env.SKILLJIT_GITHUB_TOKEN;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  } as RequestInit);
  if (res.status === 403 || res.status === 429) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API rate limit hit while ingesting (status ${res.status}). ` +
        `Set SKILLJIT_GITHUB_TOKEN to raise the limit from 60/hr to 5000/hr. ${body}`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${url}`);
  }
  return res;
}

/**
 * Ingest every SKILL.md found in a GitHub repo, via the git trees API
 * (one recursive call, no per-directory listing) and raw.githubusercontent.com
 * for content — both public, unauthenticated-friendly endpoints, so this
 * scales to skilljit's default repo list without needing a GitHub App.
 */
export async function ingestGithubRepo(
  owner: string,
  repo: string,
  opts: GithubIngestOptions = {},
): Promise<SkillRecord[]> {
  const source = `github:${owner}/${repo}`;
  let ref = opts.ref;
  if (!ref) {
    const repoRes = await githubApiFetch(`https://api.github.com/repos/${owner}/${repo}`, opts);
    const repoJson = (await repoRes.json()) as { default_branch: string };
    ref = repoJson.default_branch;
  }

  const treeRes = await githubApiFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
    opts,
  );
  const treeJson = (await treeRes.json()) as {
    truncated?: boolean;
    tree: { path: string; type: string }[];
  };
  if (treeJson.truncated) {
    // eslint-disable-next-line no-console
    console.warn(
      `skilljit: ${owner}/${repo}'s file tree was truncated by GitHub's API — some SKILL.md files may be missed.`,
    );
  }

  const skillPaths = treeJson.tree.filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/.test(e.path));

  const results: SkillRecord[] = [];
  for (const entry of skillPaths) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${entry.path}`;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(rawUrl);
    if (!res.ok) continue;
    const content = await res.text();
    const parsed = parseSkillMd(content, { source, path: entry.path });
    if (parsed) results.push(parsed);
  }
  return results;
}
