import { describe, expect, it } from "vitest";

// Import the pure-helper module directly: importing "./executor" would pull in
// runtime deps ("../settings", "../github") that other groups own and that may
// not exist yet while modules are written in parallel. executor.ts re-exports
// these same symbols, so the public contract is unchanged.
import {
  buildBranchName,
  buildPrTitle,
  MAX_PR_TITLE_LEN,
  scrubSecret,
  slugify,
} from "./executor-helpers";

describe("slugify", () => {
  it("lowercases and dashes a plain title", () => {
    expect(slugify("Fix login redirect loop")).toBe("fix-login-redirect-loop");
  });

  it("strips punctuation and collapses runs of separators", () => {
    expect(slugify("Bug: `useAuth()`   throws -- sometimes!!")).toBe("bug-useauth-throws-sometimes");
  });

  it("strips diacritics via NFKD", () => {
    expect(slugify("Café crème naïve")).toBe("cafe-creme-naive");
  });

  it("drops non-latin scripts entirely (arabic)", () => {
    expect(slugify("إصلاح تسجيل الدخول")).toBe("");
  });

  it("caps length at 40 chars without a trailing dash", () => {
    const slug = slugify(
      "This is an extremely long issue title that should definitely be cut off somewhere",
    );
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("this-is-an-extremely-long-issue-title-th");
  });

  it("respects a custom maxLen", () => {
    expect(slugify("hello wonderful world", 8)).toBe("hello-wo");
  });

  it("returns empty string for empty/symbol-only input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!! ***")).toBe("");
  });
});

describe("buildBranchName", () => {
  it("builds the standup/issue-<n>-<slug> shape", () => {
    expect(buildBranchName(42, "Fix login redirect loop")).toBe(
      "standup/issue-42-fix-login-redirect-loop",
    );
  });

  it("omits the slug when the title produces none", () => {
    expect(buildBranchName(7, "!!!")).toBe("standup/issue-7");
    expect(buildBranchName(7, "إصلاح")).toBe("standup/issue-7");
  });

  it("keeps the slug within 40 chars", () => {
    const branch = buildBranchName(
      1234,
      "An incredibly verbose issue title that goes on and on and on forever",
    );
    expect(branch.startsWith("standup/issue-1234-")).toBe(true);
    const slug = branch.slice("standup/issue-1234-".length);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("buildPrTitle", () => {
  it("appends the issue number suffix", () => {
    expect(buildPrTitle("Fix login redirect loop", 42)).toBe("Fix login redirect loop (#42)");
  });

  it("never exceeds GitHub's 256-char limit and keeps the suffix", () => {
    const long = "x".repeat(500);
    const title = buildPrTitle(long, 12345);
    expect(title.length).toBeLessThanOrEqual(MAX_PR_TITLE_LEN);
    expect(title.endsWith(" (#12345)")).toBe(true);
    expect(title).toContain("…");
  });

  it("falls back to a generic title when the issue title is blank", () => {
    expect(buildPrTitle("   ", 7)).toBe("issue 7 (#7)");
  });

  it("leaves short titles untouched", () => {
    const exact = "y".repeat(200);
    expect(buildPrTitle(exact, 1)).toBe(`${exact} (#1)`);
  });
});

describe("scrubSecret", () => {
  const pat = "ghp_AbCdEf0123456789AbCdEf0123456789AbCd";

  it("replaces every occurrence of the secret", () => {
    const line = `cloning https://x-access-token:${pat}@github.com/o/r.git with token ${pat}`;
    const out = scrubSecret(line, pat);
    expect(out).not.toContain(pat);
    expect(out).toContain("***");
  });

  it("masks x-access-token URL userinfo even without the secret argument", () => {
    const line = "fatal: unable to access 'https://x-access-token:sometoken@github.com/o/r.git/'";
    const out = scrubSecret(line);
    expect(out).not.toContain("sometoken");
    expect(out).toContain("x-access-token:***@");
  });

  it("handles secrets containing regex metacharacters safely", () => {
    const weird = "a+b(c)*d?[e]";
    const out = scrubSecret(`before ${weird} after`, weird);
    expect(out).toBe("before *** after");
  });

  it("is a no-op when the secret is absent from the line", () => {
    expect(scrubSecret("nothing sensitive here", pat)).toBe("nothing sensitive here");
  });

  it("tolerates undefined/null/empty secrets", () => {
    expect(scrubSecret("plain line", undefined)).toBe("plain line");
    expect(scrubSecret("plain line", null)).toBe("plain line");
    expect(scrubSecret("plain line", "")).toBe("plain line");
  });
});
