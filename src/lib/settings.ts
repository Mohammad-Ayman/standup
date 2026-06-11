/**
 * Settings + secrets accessors backed by the `settings` table.
 *
 * - Secrets are stored encrypted (AES-256-GCM via src/lib/crypto) in
 *   `secret_ciphertext` with `is_secret = true` and `value = null`.
 * - Plain settings live in the `value` jsonb column.
 * - getSecret() falls back to env vars (GITHUB_PAT / CLAUDE_CODE_OAUTH_TOKEN)
 *   when no DB row is set — useful for bootstrap before the settings UI.
 * - Plaintext secrets are never exposed except through getSecret()
 *   (server-side only). getSecretStatus() returns only set/last4.
 *
 * Framework-agnostic: no next/react imports allowed here.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../db/client";
import { settings, type SettingRow } from "../db/schema";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

export type SettingKey =
  | "github_pat"
  | "claude_oauth_token"
  | "schedule_cron"
  | "schedule_tz"
  | "max_issues_per_run"
  | "planner_model"
  | "executor_model"
  | "replan_rejected";

type SecretKey = Extract<SettingKey, "github_pat" | "claude_oauth_token">;

const SECRET_ENV_FALLBACK: Record<SecretKey, string> = {
  github_pat: "GITHUB_PAT",
  claude_oauth_token: "CLAUDE_CODE_OAUTH_TOKEN",
};

const DEFAULT_SCHEDULE_CRON = "0 7 * * *";
const DEFAULT_SCHEDULE_TZ = "UTC";
const DEFAULT_MAX_ISSUES_PER_RUN = 10;

async function getSettingRow(key: SettingKey): Promise<SettingRow | undefined> {
  const db = getDb();
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return rows[0];
}

/**
 * Decrypted secret value. DB row first; env fallback
 * (GITHUB_PAT / CLAUDE_CODE_OAUTH_TOKEN) when unset. Server-side only —
 * never return this value to the client.
 */
export async function getSecret(key: SecretKey): Promise<string | null> {
  const row = await getSettingRow(key);
  if (row?.secretCiphertext) {
    return decryptSecret(row.secretCiphertext);
  }
  const envValue = process.env[SECRET_ENV_FALLBACK[key]];
  return envValue && envValue.length > 0 ? envValue : null;
}

export async function setSecret(
  key: SecretKey,
  plaintext: string,
  updatedBy?: number,
): Promise<void> {
  const db = getDb();
  const secretCiphertext = encryptSecret(plaintext);
  const now = new Date();
  await db
    .insert(settings)
    .values({
      key,
      value: null,
      secretCiphertext,
      isSecret: true,
      updatedBy: updatedBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: null,
        secretCiphertext,
        isSecret: true,
        updatedBy: updatedBy ?? null,
        updatedAt: now,
      },
    });
}

/** Masked status for the settings UI — never exposes the plaintext. */
export async function getSecretStatus(
  key: SecretKey,
): Promise<{ set: boolean; last4?: string }> {
  const plaintext = await getSecret(key);
  if (!plaintext) {
    return { set: false };
  }
  return maskSecret(plaintext);
}

export async function getSettingValue<T>(
  key: SettingKey,
  fallback: T,
): Promise<T> {
  const row = await getSettingRow(key);
  if (!row || row.isSecret || row.value === null || row.value === undefined) {
    return fallback;
  }
  return row.value as T;
}

export async function setSettingValue(
  key: SettingKey,
  value: unknown,
  updatedBy?: number,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(settings)
    .values({
      key,
      value,
      secretCiphertext: null,
      isSecret: false,
      updatedBy: updatedBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value,
        secretCiphertext: null,
        isSecret: false,
        updatedBy: updatedBy ?? null,
        updatedAt: now,
      },
    });
}

const nonEmptyStringZ = z.string().trim().min(1);

export async function getSchedule(): Promise<{ cron: string; tz: string }> {
  const rawCron = await getSettingValue<unknown>(
    "schedule_cron",
    DEFAULT_SCHEDULE_CRON,
  );
  const rawTz = await getSettingValue<unknown>(
    "schedule_tz",
    DEFAULT_SCHEDULE_TZ,
  );
  const cron = nonEmptyStringZ.safeParse(rawCron);
  const tz = nonEmptyStringZ.safeParse(rawTz);
  return {
    cron: cron.success ? cron.data : DEFAULT_SCHEDULE_CRON,
    tz: tz.success ? tz.data : DEFAULT_SCHEDULE_TZ,
  };
}

export async function getMaxIssuesPerRun(): Promise<number> {
  const raw = await getSettingValue<unknown>(
    "max_issues_per_run",
    DEFAULT_MAX_ISSUES_PER_RUN,
  );
  const parsed = z.number().int().min(1).safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_MAX_ISSUES_PER_RUN;
}
