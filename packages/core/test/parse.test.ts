import { describe, it, expect } from "vitest";
import { parseSkillMd } from "../src/ingest/parse.js";

describe("parseSkillMd", () => {
  it("parses frontmatter name/description and keeps the body", () => {
    const content = `---
name: pdf-processing
description: Extract text and tables from PDF files. Use when working with PDFs.
---

# PDF processing

Use pdfplumber to extract text.
`;
    const result = parseSkillMd(content, { source: "github:acme/repo", path: "pdf-processing/SKILL.md" });
    expect(result?.name).toBe("pdf-processing");
    expect(result?.description).toContain("Use when working with PDFs");
    expect(result?.body).toContain("pdfplumber");
    expect(result?.id).toBe("github:acme/repo/pdf-processing");
  });

  it("returns null when there is no frontmatter", () => {
    const result = parseSkillMd("# Just a heading, no frontmatter", {
      source: "github:acme/repo",
      path: "x/SKILL.md",
    });
    expect(result).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const content = `---
name: only-a-name
---
body`;
    const result = parseSkillMd(content, { source: "github:acme/repo", path: "x/SKILL.md" });
    expect(result).toBeNull();
  });

  it("returns null when name violates the spec (uppercase/underscore not allowed)", () => {
    const content = `---
name: Bad_Name
description: something
---
body`;
    const result = parseSkillMd(content, { source: "github:acme/repo", path: "x/SKILL.md" });
    expect(result).toBeNull();
  });

  it("returns null when description exceeds 1024 characters", () => {
    const content = `---
name: too-long
description: ${"a".repeat(1025)}
---
body`;
    const result = parseSkillMd(content, { source: "github:acme/repo", path: "x/SKILL.md" });
    expect(result).toBeNull();
  });
});
