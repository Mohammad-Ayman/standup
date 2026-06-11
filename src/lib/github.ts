/**
 * GitHub client helpers — the single place that constructs Octokit instances.
 *
 * Uses the `octokit` umbrella package (throttling + retry plugins built in).
 * The PAT comes from settings (encrypted DB row, env fallback) and is never
 * logged or embedded in error messages.
 *
 * Framework-agnostic: no next/react imports allowed here.
 */
import { Octokit } from "octokit";

import { getSecret } from "./settings";

/**
 * Authenticated Octokit using the configured GitHub PAT.
 * Throws Error('github_pat not configured') when no PAT is set.
 */
export async function getOctokit(): Promise<Octokit> {
  const pat = await getSecret("github_pat");
  if (!pat) {
    throw new Error("github_pat not configured");
  }
  return new Octokit({ auth: pat });
}

function errorStatus(err: unknown): number | undefined {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}

/**
 * Validate a PAT by calling GET /user. Never throws; never includes the
 * token in the returned error string.
 */
export async function validatePat(
  pat: string,
): Promise<{ ok: boolean; login?: string; error?: string }> {
  const trimmed = pat.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Token is empty." };
  }
  const octokit = new Octokit({ auth: trimmed });
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return { ok: true, login: data.login };
  } catch (err) {
    const status = errorStatus(err);
    if (status === 401) {
      return {
        ok: false,
        error:
          "GitHub rejected the token (401 Unauthorized). Check that the PAT is valid and not expired.",
      };
    }
    if (status === 403) {
      return {
        ok: false,
        error:
          "GitHub denied the request (403). The token may lack required scopes or the rate limit was hit.",
      };
    }
    const message = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      error: `GitHub API error${status ? ` (${status})` : ""}: ${message}`,
    };
  }
}

/**
 * Repo metadata used when registering a watched repo (settings UI).
 */
export async function getRepoMeta(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<{ githubRepoId: number; defaultBranch: string }> {
  const { data } = await octokit.rest.repos.get({ owner, repo: name });
  return { githubRepoId: data.id, defaultBranch: data.default_branch };
}
