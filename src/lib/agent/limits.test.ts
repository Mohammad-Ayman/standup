import { describe, expect, it } from "vitest";

import {
  classifyError,
  isUsageLimitError,
  parseResumeAt,
  toClassifiedError,
  unixToDate,
  UsageLimitError,
} from "./limits";

describe("classifyError", () => {
  describe("usage_limit fixtures", () => {
    const fixtures = [
      "Claude AI usage limit reached|1764400000",
      "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Number of requests has exceeded your per-minute rate limit\"}}",
      "rate_limit",
      "Request failed with status 529: overloaded_error",
      "overloaded",
      "Your limit will reset at 2026-06-11T07:00:00Z",
      "5-hour limit reached · resets 4pm",
      "Too Many Requests",
      "quota exceeded for this billing period", // limit wins over billing
    ];
    for (const message of fixtures) {
      it(`classifies ${JSON.stringify(message.slice(0, 60))} as usage_limit`, () => {
        expect(classifyError(new Error(message))).toBe("usage_limit");
        expect(classifyError(message)).toBe("usage_limit");
      });
    }
  });

  describe("auth fixtures", () => {
    const fixtures = [
      "401 Unauthorized",
      "authentication_failed",
      "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid bearer token\"}}",
      "OAuth token has expired. Please run /login.",
      "oauth_org_not_allowed",
      "billing_error",
      "Invalid API key provided",
    ];
    for (const message of fixtures) {
      it(`classifies ${JSON.stringify(message.slice(0, 60))} as auth`, () => {
        expect(classifyError(new Error(message))).toBe("auth");
      });
    }
  });

  describe("other fixtures", () => {
    const fixtures = [
      "ENOTFOUND github.com",
      "agent run timed out after 900000 ms",
      "SyntaxError: Unexpected token < in JSON",
      "process exited with code 1",
    ];
    for (const message of fixtures) {
      it(`classifies ${JSON.stringify(message)} as other`, () => {
        expect(classifyError(new Error(message))).toBe("other");
      });
    }

    it("handles non-Error values", () => {
      expect(classifyError(undefined)).toBe("other");
      expect(classifyError(null)).toBe("other");
      expect(classifyError(42)).toBe("other");
      expect(classifyError({ message: "429 too many requests" })).toBe("usage_limit");
    });
  });

  it("classifies UsageLimitError instances as usage_limit regardless of message", () => {
    expect(classifyError(new UsageLimitError("anything at all"))).toBe("usage_limit");
  });
});

describe("isUsageLimitError", () => {
  it("matches instances", () => {
    const e = new UsageLimitError("limit", new Date());
    expect(isUsageLimitError(e)).toBe(true);
  });

  it("matches duck-typed cross-realm objects", () => {
    const fake = Object.assign(new Error("limit"), { name: "UsageLimitError", resumeAt: null });
    expect(isUsageLimitError(fake)).toBe(true);
  });

  it("rejects plain errors and non-errors", () => {
    expect(isUsageLimitError(new Error("rate limit"))).toBe(false);
    expect(isUsageLimitError("UsageLimitError")).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
  });
});

describe("parseResumeAt", () => {
  it("parses the pipe + unix-seconds Claude Code format", () => {
    const d = parseResumeAt("Claude AI usage limit reached|1764400000");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBe(1764400000 * 1000);
  });

  it("parses pipe + unix-milliseconds", () => {
    const d = parseResumeAt("usage limit reached|1764400000000");
    expect(d!.getTime()).toBe(1764400000000);
  });

  it("parses a unix timestamp after 'reset'", () => {
    const d = parseResumeAt("Your limit will reset at 1764400000");
    expect(d!.getTime()).toBe(1764400000 * 1000);
  });

  it("parses an ISO 8601 timestamp", () => {
    const d = parseResumeAt("rate limited; resets at 2026-06-11T07:00:00Z");
    expect(d!.toISOString()).toBe("2026-06-11T07:00:00.000Z");
  });

  it("returns null when no timestamp is present", () => {
    expect(parseResumeAt("rate limit exceeded, try again later")).toBeNull();
  });

  it("ignores implausible timestamps (e.g. short ids)", () => {
    expect(parseResumeAt("error code 12345 happened")).toBeNull();
  });
});

describe("unixToDate", () => {
  it("treats < 1e12 as seconds and >= 1e12 as milliseconds", () => {
    expect(unixToDate(1764400000)!.getTime()).toBe(1764400000 * 1000);
    expect(unixToDate(1764400000000)!.getTime()).toBe(1764400000000);
  });

  it("rejects nonsense", () => {
    expect(unixToDate(0)).toBeNull();
    expect(unixToDate(-5)).toBeNull();
    expect(unixToDate(Number.NaN)).toBeNull();
  });
});

describe("toClassifiedError", () => {
  it("builds UsageLimitError with parsed resumeAt for limit messages", () => {
    const e = toClassifiedError("Claude AI usage limit reached|1764400000");
    expect(isUsageLimitError(e)).toBe(true);
    expect((e as UsageLimitError).resumeAt!.getTime()).toBe(1764400000 * 1000);
  });

  it("builds a plain auth Error for auth messages", () => {
    const e = toClassifiedError("401 authentication_error");
    expect(isUsageLimitError(e)).toBe(false);
    expect(e.message).toContain("auth");
  });

  it("passes other messages through as plain Errors", () => {
    const e = toClassifiedError("ENOTFOUND github.com");
    expect(isUsageLimitError(e)).toBe(false);
    expect(e.message).toBe("ENOTFOUND github.com");
  });
});
