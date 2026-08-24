export interface RedactResult {
  /** False only if the redaction pass itself failed to run — the signal
   * capture-incident uses to fail closed and write nothing, per the
   * design spec's Safety & governance section. Regex completeness is a
   * best-effort mechanical layer, not what "clean" is claiming. */
  clean: boolean;
  text: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+/gi,
];

/**
 * Best-effort mechanical secret scrubbing, run on every synthesized
 * incident field before it touches disk. This cannot catch every
 * sensitive-data shape — the actual safety net is capture-incident
 * failing closed if this function throws, not the pattern list being
 * exhaustive. See the design spec's "Open risks" section.
 */
export function redactSecrets(text: string): RedactResult {
  try {
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return { clean: true, text: redacted };
  } catch {
    return { clean: false, text: "" };
  }
}
