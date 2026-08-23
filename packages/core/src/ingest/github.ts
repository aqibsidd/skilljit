import { parseSkillMd } from "./parse.js";
import { isProbablyBinaryPath } from "./files.js";
import type { SkillRecord } from "../types.js";

export interface GithubIngestOptions {
  /** Injectable for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Personal access token (or SKILLJIT_GITHUB_TOKEN env var) for the 5000/hr rate limit. */
  token?: string;
  /** Override branch/ref instead of the repo's default branch. */
  ref?: string;
}

function resolveToken(opts: GithubIngestOptions): string | undefined {
  return opts.token ?? process.env.SKILLJIT_GITHUB_TOKEN;
}

function authHeaders(opts: GithubIngestOptions): Record<string, string> {
  const token = resolveToken(opts);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function githubApiFetch(url: string, opts: GithubIngestOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...authHeaders(opts),
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

/** Fetch a raw file's content, authenticated — this is what makes private
 * repos actually work. Without the Authorization header here, GitHub
 * returns 404 for any private repo's raw content even though the caller
 * has a valid token, and the ingest loop below silently skips the file. */
async function fetchRawFile(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  opts: GithubIngestOptions,
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  const res = await fetchImpl(rawUrl, { headers: authHeaders(opts) } as RequestInit);
  if (!res.ok) return null;
  return res.text();
}

/**
 * Ingest every SKILL.md found in a GitHub repo, via the git trees API
 * (one recursive call, no per-directory listing) and raw.githubusercontent.com
 * for content — both public, unauthenticated-friendly endpoints, so this
 * scales to skilljit's default repo list without needing a GitHub App.
 *
 * Also bundles each skill's sibling files (references, helper scripts) —
 * anything else living under the same directory as its SKILL.md — so
 * skill_read_file has something to serve. A skill whose SKILL.md sits at
 * the repo root is skipped for bundling (its "siblings" would be the
 * entire rest of the repo, not files that belong to it).
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

  const blobPaths = treeJson.tree.filter((e) => e.type === "blob").map((e) => e.path);
  const skillPaths = blobPaths.filter((p) => /(^|\/)SKILL\.md$/.test(p));

  const results: SkillRecord[] = [];
  for (const skillPath of skillPaths) {
    const content = await fetchRawFile(owner, repo, ref, skillPath, opts);
    if (content === null) continue;
    const parsed = parseSkillMd(content, { source, path: skillPath });
    if (!parsed) continue;

    const dir = skillPath.replace(/\/SKILL\.md$/i, "");
    if (dir !== skillPath) {
      const siblingPaths = blobPaths.filter(
        (p) => p !== skillPath && p.startsWith(`${dir}/`) && !isProbablyBinaryPath(p),
      );
      const files: SkillRecord["files"] = [];
      for (const siblingPath of siblingPaths) {
        const siblingContent = await fetchRawFile(owner, repo, ref, siblingPath, opts);
        if (siblingContent === null) continue;
        files.push({ path: siblingPath.slice(dir.length + 1), content: siblingContent });
      }
      if (files.length > 0) parsed.files = files;
    }

    results.push(parsed);
  }
  return results;
}
