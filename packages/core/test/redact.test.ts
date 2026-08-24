import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts an AWS-style access key", () => {
    const result = redactSecrets("the key was AKIAABCDEFGHIJKLMNOP in the config");
    expect(result.clean).toBe(true);
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a GitHub personal access token", () => {
    const token = "ghp_" + "a".repeat(36);
    const result = redactSecrets(`auth failed with token ${token}`);
    expect(result.text).not.toContain(token);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactSecrets(`session token: ${jwt}`);
    expect(result.text).not.toContain(jwt);
  });

  it("redacts an email address", () => {
    const result = redactSecrets("reported by jane.doe@example.com in the ticket");
    expect(result.text).not.toContain("jane.doe@example.com");
  });

  it("redacts an IPv4 address", () => {
    const result = redactSecrets("connection refused from 10.20.30.40");
    expect(result.text).not.toContain("10.20.30.40");
  });

  it("redacts a database connection string", () => {
    const result = redactSecrets("postgres://user:pw@db.internal:5432/prod");
    expect(result.text).not.toContain("user:pw@db.internal");
  });

  it("leaves ordinary prose untouched", () => {
    const text = "The retry loop had an off-by-one error in the backoff calculation.";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.clean).toBe(true);
  });

  it("fails closed (clean: false) if redaction itself throws", () => {
    // @ts-expect-error deliberately passing a non-string to exercise the catch path
    const result = redactSecrets(null);
    expect(result.clean).toBe(false);
  });
});
