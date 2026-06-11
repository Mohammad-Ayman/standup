/**
 * Allowlist of GitHub logins permitted to sign in to the dashboard.
 *
 * Logins are stored lowercased. If the table is empty, the first
 * isAllowed() call lazily seeds it from the ALLOWED_GITHUB_LOGINS env var
 * (comma-separated GitHub usernames).
 *
 * Framework-agnostic: no next/react imports allowed here (worker-safe).
 */
import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { allowlist } from "../db/schema";

/**
 * Seed the allowlist table from the ALLOWED_GITHUB_LOGINS env var
 * (comma-separated, case-insensitive). Idempotent — existing rows are
 * left untouched (ON CONFLICT DO NOTHING).
 */
export async function seedAllowlistFromEnv(): Promise<void> {
  const raw = process.env.ALLOWED_GITHUB_LOGINS ?? "";
  const logins = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  );
  if (logins.length === 0) {
    return;
  }

  const db = getDb();
  await db
    .insert(allowlist)
    .values(logins.map((login) => ({ login, addedBy: "env" })))
    .onConflictDoNothing();
}

/**
 * Case-insensitive allowlist check. If the table is empty, seeds it from
 * the environment first so a fresh deployment works without manual setup.
 */
export async function isAllowed(login: string): Promise<boolean> {
  const db = getDb();

  const anyRow = await db
    .select({ login: allowlist.login })
    .from(allowlist)
    .limit(1);
  if (anyRow.length === 0) {
    await seedAllowlistFromEnv();
  }

  const normalized = login.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const match = await db
    .select({ login: allowlist.login })
    .from(allowlist)
    .where(eq(allowlist.login, normalized))
    .limit(1);
  return match.length > 0;
}
