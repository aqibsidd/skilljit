import { describe, it, expect, vi } from "vitest";
import { ingestGithubRepo } from "../src/ingest/github.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

const SKILL_MD = `---
name: pdf-processing
description: Extract text from PDFs. Use when working with PDF files.
---
body`;

describe("ingestGithubRepo", () => {
  it("finds SKILL.md files via the git tree API and fetches+parses each one", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/repos/acme/repo") && !url.includes("/git/trees")) {
        return jsonResponse({ default_branch: "main" });
      }
      if (url.includes("/git/trees/main")) {
        return jsonResponse({
          truncated: false,
          tree: [
            { path: "skills/pdf-processing/SKILL.md", type: "blob" },
            { path: "README.md", type: "blob" },
            { path: "skills/other/notSKILL.md", type: "blob" },
          ],
        });
      }
      if (url.includes("raw.githubusercontent.com")) {
        return textResponse(SKILL_MD);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const skills = await ingestGithubRepo("acme", "repo", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("pdf-processing");
    expect(skills[0].source).toBe("github:acme/repo");
  });

  it("skips files that fail to parse instead of throwing", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/git/trees")) {
        return jsonResponse({ truncated: false, tree: [{ path: "a/SKILL.md", type: "blob" }] });
      }
      if (!url.includes("/git/trees") && url.includes("/repos/")) return jsonResponse({ default_branch: "main" });
      return textResponse("not valid frontmatter at all");
    });
    const skills = await ingestGithubRepo("acme", "repo", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(skills).toHaveLength(0);
  });

  it("throws a clear error when the GitHub API rate-limits the request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403),
    );
    await expect(
      ingestGithubRepo("acme", "repo", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/rate limit/i);
  });

  it("attaches the auth token to raw content fetches, not just the API calls", async () => {
    const seenAuth: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/repos/acme/repo") && !url.includes("/git/trees")) {
        return jsonResponse({ default_branch: "main" });
      }
      if (url.includes("/git/trees/main")) {
        return jsonResponse({ truncated: false, tree: [{ path: "a/SKILL.md", type: "blob" }] });
      }
      if (url.includes("raw.githubusercontent.com")) {
        seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
        return textResponse(SKILL_MD);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    await ingestGithubRepo("acme", "repo", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: "secret-token",
    });

    expect(seenAuth).toHaveLength(1);
    expect(seenAuth[0]).toBe("Bearer secret-token");
  });

  it("a private repo's unauthenticated raw fetch (404) is skipped instead of ingesting empty content", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/repos/acme/repo") && !url.includes("/git/trees")) {
        return jsonResponse({ default_branch: "main" });
      }
      if (url.includes("/git/trees/main")) {
        return jsonResponse({ truncated: false, tree: [{ path: "a/SKILL.md", type: "blob" }] });
      }
      if (url.includes("raw.githubusercontent.com")) {
        return textResponse("not found", 404);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const skills = await ingestGithubRepo("acme", "repo", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(skills).toHaveLength(0);
  });

  it("bundles a skill's sibling files (references/scripts under the same directory)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/repos/acme/repo") && !url.includes("/git/trees")) {
        return jsonResponse({ default_branch: "main" });
      }
      if (url.includes("/git/trees/main")) {
        return jsonResponse({
          truncated: false,
          tree: [
            { path: "skills/pdf-processing/SKILL.md", type: "blob" },
            { path: "skills/pdf-processing/references/checklist.md", type: "blob" },
            { path: "skills/pdf-processing/logo.png", type: "blob" },
            { path: "skills/other/README.md", type: "blob" },
          ],
        });
      }
      if (url.includes("references/checklist.md")) return textResponse("- step one");
      if (url.includes("logo.png")) throw new Error("should not fetch binary files");
      if (url.includes("skills/pdf-processing/SKILL.md")) return textResponse(SKILL_MD);
      throw new Error(`unexpected url: ${url}`);
    });

    const skills = await ingestGithubRepo("acme", "repo", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(skills).toHaveLength(1);
    expect(skills[0].files).toEqual([{ path: "references/checklist.md", content: "- step one" }]);
  });

  it("skips file-bundling for a SKILL.md sitting at the repo root", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/repos/acme/repo") && !url.includes("/git/trees")) {
        return jsonResponse({ default_branch: "main" });
      }
      if (url.includes("/git/trees/main")) {
        return jsonResponse({
          truncated: false,
          tree: [
            { path: "SKILL.md", type: "blob" },
            { path: "unrelated-repo-file.txt", type: "blob" },
          ],
        });
      }
      return textResponse(SKILL_MD);
    });

    const skills = await ingestGithubRepo("acme", "repo", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(skills).toHaveLength(1);
    expect(skills[0].files).toBeUndefined();
  });
});
