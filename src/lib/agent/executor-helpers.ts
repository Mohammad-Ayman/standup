/**
 * Pure executor helpers — no DB, no SDK, no octokit imports, so they can be
 * unit-tested (and reused) without pulling in the executor's runtime deps.
 * Re-exported by executor.ts.
 */

export class ExecutionError extends Error {
  constructor(
    public readonly code:
      | "no_changes"
      | "workflow_change_not_in_plan"
      | "not_found"
      | "invalid_state"
      | "push_refused"
      | "git_failed",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ExecutionError";
  }
}

/** Lowercase, ascii-dash slug, collapsed dashes, trimmed, capped at maxLen. */
export function slugify(input: string, maxLen = 40): string {
  let slug = input
    .toLowerCase()
    .normalize("NFKD")
    // strip diacritics (combining marks left over from NFKD)
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen).replace(/-+$/g, "");
  }
  return slug;
}

/** standup/issue-<number>-<slug(title, 40)> (slug omitted when empty). */
export function buildBranchName(issueNumber: number, title: string): string {
  const slug = slugify(title, 40);
  return slug ? `standup/issue-${issueNumber}-${slug}` : `standup/issue-${issueNumber}`;
}

/** GitHub rejects PR titles longer than 256 chars with a 422. */
export const MAX_PR_TITLE_LEN = 256;

/**
 * `<issueTitle> (#<issueNumber>)`, truncated so the whole title fits in
 * GitHub's 256-char limit while always preserving the issue-number suffix.
 */
export function buildPrTitle(
  issueTitle: string,
  issueNumber: number,
  maxLen = MAX_PR_TITLE_LEN,
): string {
  const suffix = ` (#${issueNumber})`;
  let title = issueTitle.trim() || `issue ${issueNumber}`;
  const room = maxLen - suffix.length;
  if (title.length > room) {
    title = `${title.slice(0, room - 1).trimEnd()}…`;
  }
  return `${title}${suffix}`;
}

/**
 * Remove a secret from a log line. Uses split/join (not RegExp) so secrets
 * containing regex metacharacters are handled safely. Also masks any
 * x-access-token URL userinfo as defense in depth (covers git's own echo of
 * the remote URL).
 */
export function scrubSecret(line: string, secret?: string | null): string {
  let out = line;
  if (secret && secret.length > 0) {
    out = out.split(secret).join("***");
  }
  out = out.replace(/x-access-token:[^@\s/]+@/g, "x-access-token:***@");
  return out;
}
