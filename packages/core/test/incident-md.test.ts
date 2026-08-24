import { describe, it, expect } from "vitest";
import { parseIncidentMd, serializeIncidentMd } from "../src/ingest/incident-md.js";
import type { IncidentRecord } from "../src/types.js";

describe("serializeIncidentMd + parseIncidentMd", () => {
  const record: Omit<IncidentRecord, "id"> = {
    symptom: "Checkout requests time out under load after a deploy.",
    investigation: "Ruled out the payment provider. Traced it to a new DB index migration holding a lock.",
    rootCause: "The migration ran ACCESS EXCLUSIVE against a hot table without a maintenance window.",
    fix: "Reran the migration with CREATE INDEX CONCURRENTLY instead.",
    commitSha: "a1b2c3d4e5f6",
    repo: "git:git@example.com:acme/webapp.git",
    filesTouched: ["migrations/0042_add_index.sql"],
    capturedAt: "2026-08-24T12:00:00.000Z",
    verified: false,
  };

  it("round-trips every field through serialize -> parse", () => {
    const md = serializeIncidentMd(record);
    const parsed = parseIncidentMd(md, { source: record.repo });
    expect(parsed).not.toBeNull();
    expect(parsed?.symptom).toBe(record.symptom);
    expect(parsed?.investigation).toBe(record.investigation);
    expect(parsed?.rootCause).toBe(record.rootCause);
    expect(parsed?.fix).toBe(record.fix);
    expect(parsed?.commitSha).toBe(record.commitSha);
    expect(parsed?.filesTouched).toEqual(record.filesTouched);
    expect(parsed?.verified).toBe(false);
    expect(parsed?.repo).toBe(record.repo);
    expect(parsed?.capturedAt).toBe(record.capturedAt);
  });

  it("derives id from source + short commit sha", () => {
    const md = serializeIncidentMd(record);
    const parsed = parseIncidentMd(md, { source: record.repo });
    expect(parsed?.id).toBe(`${record.repo}/incidents/a1b2c3d`);
  });

  it("defaults verified to false when the frontmatter omits it", () => {
    const md = serializeIncidentMd(record).replace(/verified: false\n/, "");
    const parsed = parseIncidentMd(md, { source: record.repo });
    expect(parsed?.verified).toBe(false);
  });

  it("returns null for content with no frontmatter", () => {
    expect(parseIncidentMd("just some text, no frontmatter", { source: "x" })).toBeNull();
  });

  it("returns null when a required frontmatter field is missing", () => {
    const md = serializeIncidentMd(record).replace(/rootCause: .*\n/, "");
    expect(parseIncidentMd(md, { source: record.repo })).toBeNull();
  });

  it("returns null when the body is missing the Fix section", () => {
    const md = serializeIncidentMd(record).replace(/## Fix[\s\S]*/, "");
    expect(parseIncidentMd(md, { source: record.repo })).toBeNull();
  });
});
