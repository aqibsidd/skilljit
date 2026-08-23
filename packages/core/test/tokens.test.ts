import { describe, it, expect } from "vitest";
import { countTokens, estimateSkillMetadataTokens, TokenLedger } from "../src/tokens.js";
import type { SkillRecord } from "../src/types.js";

describe("countTokens", () => {
  it("counts more tokens for longer text", () => {
    const short = countTokens("hello");
    const long = countTokens("hello ".repeat(200));
    expect(long).toBeGreaterThan(short * 50);
  });

  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });
});

describe("estimateSkillMetadataTokens", () => {
  it("approximates ~100 tokens per skill the way Anthropic's docs describe", () => {
    const skill: Pick<SkillRecord, "name" | "description"> = {
      name: "pdf-processing",
      description:
        "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.",
    };
    const tokens = estimateSkillMetadataTokens(skill);
    expect(tokens).toBeGreaterThan(20);
    expect(tokens).toBeLessThan(200);
  });
});

describe("TokenLedger", () => {
  it("accumulates baseline cost for skills that would have loaded every turn", () => {
    const ledger = new TokenLedger();
    ledger.recordBaselineSkill({ name: "a", description: "does a thing" });
    ledger.recordBaselineSkill({ name: "b", description: "does another thing entirely, longer description here" });
    expect(ledger.baselineTokens()).toBeGreaterThan(0);
  });

  it("accumulates actual cost only for what was really returned", () => {
    const ledger = new TokenLedger();
    ledger.recordActual("skill_find result", "short json payload");
    expect(ledger.actualTokens()).toBeGreaterThan(0);
    expect(ledger.actualTokens()).toBeLessThan(ledger.baselineTokens() + 1000);
  });

  it("reports savings as baseline minus actual, never negative", () => {
    const ledger = new TokenLedger();
    for (let i = 0; i < 50; i++) {
      ledger.recordBaselineSkill({ name: `skill-${i}`, description: "a moderately long description ".repeat(3) });
    }
    ledger.recordActual("skill_find", "one short candidate list");
    const stats = ledger.stats();
    expect(stats.baselineTokens).toBeGreaterThan(stats.actualTokens);
    expect(stats.savedTokens).toBe(stats.baselineTokens - stats.actualTokens);
    expect(stats.savedTokens).toBeGreaterThanOrEqual(0);
  });

  it("never reports negative savings even if actual exceeds baseline", () => {
    const ledger = new TokenLedger();
    ledger.recordBaselineSkill({ name: "a", description: "x" });
    ledger.recordActual("skill_load", "a".repeat(5000));
    const stats = ledger.stats();
    expect(stats.savedTokens).toBeGreaterThanOrEqual(0);
  });
});
