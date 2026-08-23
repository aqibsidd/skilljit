/**
 * Default first-party / high-quality repos to scan for SKILL.md files.
 * This is the "direct repos" leg of catalog sourcing described in the
 * design doc — deliberately small and curated rather than an attempt to
 * mirror all 2,800+ repos skills.sh indexes. `skilljit sync --repo owner/name`
 * lets a user add their own.
 */
export const DEFAULT_GITHUB_SOURCES: { owner: string; repo: string }[] = [
  { owner: "anthropics", repo: "skills" },
  { owner: "vercel-labs", repo: "agent-skills" },
  { owner: "obra", repo: "superpowers" },
  { owner: "wshobson", repo: "agents" },
];
