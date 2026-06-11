/**
 * Usage-limit / auth error classification for Claude Agent SDK runs.
 *
 * The Agent SDK (v0.3.173) surfaces failures in three shapes we care about:
 *  1. `SDKAssistantMessage.error` — a string union:
 *     'authentication_failed' | 'oauth_org_not_allowed' | 'billing_error' |
 *     'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' |
 *     'server_error' | 'unknown' | 'max_output_tokens'
 *  2. `SDKRateLimitEvent.rate_limit_info` — { status: 'rejected', resetsAt?: number }
 *     (subscription/OAuth usage limits; resetsAt is a unix timestamp)
 *  3. Thrown errors / `SDKResultError.errors: string[]` — free-form messages such
 *     as "Claude AI usage limit reached|1764400000" (pipe + unix ts) or API
 *     error bodies containing rate_limit_error / overloaded_error / 429 / 529.
 *
 * Framework-agnostic: no next/react imports.
 */

export class UsageLimitError extends Error {
  /** When the limit is expected to reset; null when unknown. */
  resumeAt: Date | null;

  constructor(message: string, resumeAt: Date | null = null) {
    super(message);
    this.name = "UsageLimitError";
    this.resumeAt = resumeAt;
  }
}

export function isUsageLimitError(e: unknown): e is UsageLimitError {
  if (e instanceof UsageLimitError) return true;
  // Duck-type fallback (multiple module instances / serialization boundaries).
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "UsageLimitError" &&
    "resumeAt" in e
  );
}

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /rate[ _-]?limit/i, // rate_limit, rate-limit, rate limit, rate_limit_error
  /\b429\b/,
  /\b529\b/,
  /usage limit/i, // "Claude AI usage limit reached"
  /limit will reset/i,
  /limit reached/i,
  /overloaded/i, // overloaded_error
  /too many requests/i,
  /quota exceeded/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /authentication/i, // authentication_failed, authentication_error
  /unauthenticated/i,
  /unauthorized/i,
  /oauth/i, // oauth_org_not_allowed, "OAuth token has expired"
  /invalid (?:api[ _-]?key|bearer|token|credentials)/i,
  /billing/i, // billing_error — account problem, not retryable like a limit
  /permission[_ ]denied/i,
];

function messageOf(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const maybeMsg = (e as { message?: unknown }).message;
    if (typeof maybeMsg === "string") return maybeMsg;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/**
 * Classify an unknown error into 'usage_limit' | 'auth' | 'other'.
 * usage_limit is checked first: a message like "429 rate_limit_error while
 * refreshing oauth session" is a limit problem, not a credential problem.
 */
export function classifyError(e: unknown): "usage_limit" | "auth" | "other" {
  if (isUsageLimitError(e)) return "usage_limit";
  const msg = messageOf(e);
  if (USAGE_LIMIT_PATTERNS.some((re) => re.test(msg))) return "usage_limit";
  if (AUTH_PATTERNS.some((re) => re.test(msg))) return "auth";
  return "other";
}

const MIN_PLAUSIBLE_MS = Date.parse("2020-01-01T00:00:00Z");
const MAX_PLAUSIBLE_MS = Date.parse("2100-01-01T00:00:00Z");

function plausible(ms: number): Date | null {
  if (Number.isFinite(ms) && ms > MIN_PLAUSIBLE_MS && ms < MAX_PLAUSIBLE_MS) {
    return new Date(ms);
  }
  return null;
}

/** Normalize a unix timestamp that may be in seconds or milliseconds. */
export function unixToDate(ts: number): Date | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return plausible(ms);
}

/**
 * Best-effort extraction of a limit-reset timestamp out of an error message.
 * Recognized shapes:
 *  - "Claude AI usage limit reached|1764400000"      (pipe + unix seconds/ms)
 *  - "... limit will reset at 1764400000"            (unix after 'reset')
 *  - "... resets at 2026-06-11T07:00:00Z"            (ISO 8601)
 */
export function parseResumeAt(message: string): Date | null {
  // 1) pipe-delimited unix timestamp (Claude Code usage-limit format)
  const pipeMatch = message.match(/\|(\d{10,13})(?:\D|$)/);
  if (pipeMatch) {
    const d = unixToDate(Number(pipeMatch[1]));
    if (d) return d;
  }

  // 2) unix timestamp following the word "reset"
  const resetUnix = message.match(/reset[a-z ]*?(?:at\s+)?(\d{10,13})(?:\D|$)/i);
  if (resetUnix) {
    const d = unixToDate(Number(resetUnix[1]));
    if (d) return d;
  }

  // 3) ISO 8601 timestamp anywhere in the message
  const iso = message.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
  if (iso) {
    const d = plausible(Date.parse(iso[1]));
    if (d) return d;
  }

  return null;
}

/**
 * Convenience: build the right error type for a failure message.
 * Used by runAgent when the SDK stream reports a terminal error.
 */
export function toClassifiedError(message: string, resumeAt?: Date | null): Error {
  const kind = classifyError(message);
  if (kind === "usage_limit") {
    return new UsageLimitError(message, resumeAt ?? parseResumeAt(message));
  }
  if (kind === "auth") {
    return new Error(`Claude auth error: ${message}`);
  }
  return new Error(message);
}
