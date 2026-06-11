"use server";

/**
 * Server actions for the settings page — secrets, watched repos, schedule.
 *
 * Every action checks the session first (never trust the caller), validates
 * input with zod, and reports results back to /settings via short query-string
 * notices. Secret plaintext is never echoed back to the client.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
// cron-parser is the exact parser pg-boss runs at schedule() time (its direct
// dependency, same version range) — validating with it here guarantees that a
// value we report as "saved" cannot later throw inside the worker.
import { parseExpression } from "cron-parser";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/auth";
import { getDb } from "@/db/client";
import { repos } from "@/db/schema";
import { getOctokit, getRepoMeta, validatePat } from "@/lib/github";
import { getSecret, setSecret, setSettingValue } from "@/lib/settings";

const SETTINGS_PATH = "/settings";

async function requireUserId(): Promise<number> {
  const session = await auth();
  const id = Number(session?.user?.id);
  if (!session?.user?.id || !Number.isInteger(id) || id <= 0) {
    throw new Error("Unauthorized");
  }
  return id;
}

/** Redirect back to /settings with a notice in the query string. */
function settingsRedirect(params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(qs ? `${SETTINGS_PATH}?${qs}` : SETTINGS_PATH);
}

function truncate(message: string, max = 160): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SecretKeyZ = z.enum(["github_pat", "claude_oauth_token"]);

export async function saveSecretAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();

  const key = SecretKeyZ.safeParse(formData.get("key"));
  if (!key.success) {
    settingsRedirect({ error: "Unknown secret key." });
  }

  const raw = formData.get("value");
  const plaintext = typeof raw === "string" ? raw.trim() : "";
  if (plaintext.length === 0) {
    settingsRedirect({ error: "Paste a token before saving." });
  }

  await setSecret(key.data, plaintext, userId);
  revalidatePath(SETTINGS_PATH);
  settingsRedirect({ saved: key.data });
}

/**
 * Validate a GitHub PAT. Uses the token typed in the form when present,
 * otherwise falls back to the stored secret. Only the resulting login or a
 * generic error string ever reaches the client.
 */
export async function validatePatAction(formData: FormData): Promise<void> {
  await requireUserId();

  const raw = formData.get("value");
  const typed = typeof raw === "string" ? raw.trim() : "";
  const pat = typed.length > 0 ? typed : await getSecret("github_pat");
  if (!pat) {
    settingsRedirect({
      pat_error: "No PAT to validate — paste one above or save it first.",
    });
  }

  const result = await validatePat(pat);
  if (result.ok && result.login) {
    settingsRedirect({ pat_ok: result.login });
  }
  settingsRedirect({ pat_error: truncate(result.error ?? "Validation failed.") });
}

// ---------------------------------------------------------------------------
// Watched repos
// ---------------------------------------------------------------------------

const REPO_INPUT_RE =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

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

function addRepoErrorMessage(err: unknown, fullName: string): string {
  if (err instanceof Error && err.message === "github_pat not configured") {
    return "Set a GitHub PAT first (Secrets section above).";
  }
  const status = errorStatus(err);
  if (status === 404) {
    return `Repository ${fullName} was not found (or the PAT cannot see it).`;
  }
  if (status === 401 || status === 403) {
    return "GitHub rejected the request — check the PAT and its permissions.";
  }
  const message = err instanceof Error ? err.message : "unknown error";
  return truncate(`Could not add ${fullName}: ${message}`);
}

export async function addRepoAction(formData: FormData): Promise<void> {
  await requireUserId();

  const raw = formData.get("repo");
  const input = typeof raw === "string" ? raw.trim() : "";
  const match = REPO_INPUT_RE.exec(input);
  if (!match) {
    settingsRedirect({ repo_error: "Enter a repository as owner/name." });
  }
  const owner = match[1];
  const name = match[2];
  const fullName = `${owner}/${name}`;

  let notice: Record<string, string>;
  try {
    const octokit = await getOctokit();
    const meta = await getRepoMeta(octokit, owner, name);
    const inserted = await getDb()
      .insert(repos)
      .values({
        githubRepoId: meta.githubRepoId,
        owner,
        name,
        defaultBranch: meta.defaultBranch,
      })
      .onConflictDoNothing()
      .returning({ id: repos.id });
    notice =
      inserted.length > 0
        ? { repo_notice: `Now watching ${fullName}.` }
        : { repo_notice: `${fullName} is already watched.` };
  } catch (err) {
    notice = { repo_error: addRepoErrorMessage(err, fullName) };
  }

  revalidatePath(SETTINGS_PATH);
  settingsRedirect(notice);
}

const ToggleRepoZ = z.object({
  repoId: z.coerce.number().int().positive(),
  enabled: z.enum(["true", "false"]),
});

export async function toggleRepoAction(formData: FormData): Promise<void> {
  await requireUserId();

  const parsed = ToggleRepoZ.safeParse({
    repoId: formData.get("repoId"),
    enabled: formData.get("enabled"),
  });
  if (!parsed.success) {
    settingsRedirect({ repo_error: "Invalid repo toggle request." });
  }

  await getDb()
    .update(repos)
    .set({ enabled: parsed.data.enabled === "true" })
    .where(eq(repos.id, parsed.data.repoId));
  revalidatePath(SETTINGS_PATH);
}

const RemoveRepoZ = z.object({
  repoId: z.coerce.number().int().positive(),
});

export async function removeRepoAction(formData: FormData): Promise<void> {
  await requireUserId();

  const parsed = RemoveRepoZ.safeParse({ repoId: formData.get("repoId") });
  if (!parsed.success) {
    settingsRedirect({ repo_error: "Invalid repo remove request." });
  }

  await getDb().delete(repos).where(eq(repos.id, parsed.data.repoId));
  revalidatePath(SETTINGS_PATH);
}

// ---------------------------------------------------------------------------
// Schedule + planner/executor settings
// ---------------------------------------------------------------------------

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ScheduleZ = z
  .object({
    cron: z
      .string()
      .trim()
      .min(1, "Cron expression is required.")
      .refine(
        (v) => v.split(/\s+/).length === 5,
        "Cron must have exactly 5 fields (minute hour day month weekday).",
      ),
    tz: z
      .string()
      .trim()
      .min(1, "Timezone is required.")
      .refine(isValidTimeZone, "Unknown timezone (use an IANA name like Europe/Berlin)."),
    maxIssues: z.coerce
      .number()
      .int("Max issues must be a whole number.")
      .min(1, "Max issues must be at least 1.")
      .max(100, "Max issues must be 100 or less."),
    plannerModel: z.string().trim().min(1, "Planner model is required."),
    executorModel: z.string().trim().min(1, "Executor model is required."),
    replanRejected: z.boolean(),
  })
  .superRefine((v, ctx) => {
    // Field-value validation ("0 25 * * *" has 5 fields but is invalid):
    // parse with the same parser + tz pg-boss will use, so the worker can
    // never crash on a value this action accepted.
    try {
      parseExpression(v.cron, { tz: v.tz });
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["cron"],
        message: `Invalid cron expression: ${err instanceof Error ? err.message : "unparseable"}.`,
      });
    }
  });

export async function saveScheduleAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();

  const parsed = ScheduleZ.safeParse({
    cron: formData.get("cron"),
    tz: formData.get("tz"),
    maxIssues: formData.get("maxIssues"),
    plannerModel: formData.get("plannerModel"),
    executorModel: formData.get("executorModel"),
    replanRejected: formData.get("replanRejected") === "on",
  });
  if (!parsed.success) {
    settingsRedirect({
      schedule_error: truncate(
        parsed.error.issues.map((i) => i.message).join(" "),
        240,
      ),
    });
  }

  const v = parsed.data;
  await setSettingValue("schedule_cron", v.cron, userId);
  await setSettingValue("schedule_tz", v.tz, userId);
  await setSettingValue("max_issues_per_run", v.maxIssues, userId);
  await setSettingValue("planner_model", v.plannerModel, userId);
  await setSettingValue("executor_model", v.executorModel, userId);
  await setSettingValue("replan_rejected", v.replanRejected, userId);

  revalidatePath(SETTINGS_PATH);
  settingsRedirect({ saved: "schedule" });
}
