import { countTokens as gptCountTokens } from "gpt-tokenizer";
import type { SkillRecord } from "./types.js";

/**
 * Token count for a string, via a real BPE tokenizer (gpt-tokenizer's
 * cl100k encoding). This is an approximation of Claude's own tokenizer —
 * Anthropic doesn't publish one — but it is a real, auditable count of a
 * real BPE encoding, not a heuristic like "chars / 4". We say so in every
 * place this number is surfaced (see TokenLedger.stats()).
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return gptCountTokens(text);
}

/**
 * Approximate the per-turn cost of one skill's always-loaded metadata:
 * its `name` + `description`, formatted the way Claude Code renders it
 * in the system prompt (see Anthropic's Agent Skills docs example:
 * "pdf-processing - Extract text... Use when...").
 */
export function estimateSkillMetadataTokens(skill: Pick<SkillRecord, "name" | "description">): number {
  return countTokens(`${skill.name} - ${skill.description}`);
}

export interface TokenStats {
  /** What every turn would have cost with all catalogued skills/tools loaded as static metadata. */
  baselineTokens: number;
  /** What skilljit's fixed tool surface + returned candidates actually cost. */
  actualTokens: number;
  /** baselineTokens - actualTokens, floored at 0. */
  savedTokens: number;
  /** How many baseline skill/tool metadata entries were counted. */
  baselineEntries: number;
  /** Human-readable caveat about the tokenizer used. */
  method: string;
}

/**
 * Tracks two running totals for one skilljit session:
 *  - baseline: the metadata cost every catalogued skill/tool WOULD have
 *    added to every turn, had it been installed the traditional way.
 *  - actual: the real size of what skilljit actually returned over MCP
 *    (tool schemas + tool call results), nothing hypothetical.
 *
 * `stats()` reports the delta. We only count things that were genuinely
 * computed here — no invented multipliers — because this is the number
 * users will screenshot, and the whole pitch is that it's honest.
 */
export class TokenLedger {
  private baseline = 0;
  private actual = 0;
  private entries = 0;

  recordBaselineSkill(skill: Pick<SkillRecord, "name" | "description">): void {
    this.baseline += estimateSkillMetadataTokens(skill);
    this.entries += 1;
  }

  recordBaselineTool(tool: { name: string; description: string; inputSchema: unknown }): void {
    this.baseline += countTokens(`${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`);
    this.entries += 1;
  }

  recordActual(label: string, payload: string): void {
    this.actual += countTokens(payload);
  }

  baselineTokens(): number {
    return this.baseline;
  }

  actualTokens(): number {
    return this.actual;
  }

  stats(): TokenStats {
    const saved = Math.max(0, this.baseline - this.actual);
    return {
      baselineTokens: this.baseline,
      actualTokens: this.actual,
      savedTokens: saved,
      baselineEntries: this.entries,
      method:
        "Counted with gpt-tokenizer (cl100k BPE) as an approximation of Claude's tokenizer; " +
        "baseline = metadata for every catalogued skill/tool touched this session, actual = " +
        "what skilljit's fixed tool surface really returned over MCP.",
    };
  }

  reset(): void {
    this.baseline = 0;
    this.actual = 0;
    this.entries = 0;
  }
}
