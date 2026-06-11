/**
 * Run lifecycle helpers — runs + run_items state transitions.
 *
 * tryFinishRun is the single race-safe "is this run done?" primitive: every
 * worker handler calls it after finishing an item, and the reaper sweeps it
 * for any run that lost its last in-flight job.
 *
 * Framework-agnostic: no next/react imports (worker imports this).
 */
import { and, eq, ne } from "drizzle-orm";

import { getDb, getPool } from "../db/client";
import { runItems, runs, type RunRow } from "../db/schema";

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/** Insert a new run in status 'running'; returns the run id. */
export async function createRun(
  trigger: "cron" | "manual",
  triggeredBy?: number,
): Promise<number> {
  const [row] = await getDb()
    .insert(runs)
    .values({ trigger, triggeredBy: triggeredBy ?? null })
    .returning({ id: runs.id });
  if (!row) {
    throw new Error("failed to create run");
  }
  return row.id;
}

export async function getRunById(runId: number): Promise<RunRow | undefined> {
  const [row] = await getDb().select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row;
}

/** Overwrite the run's stats jsonb. */
export async function updateRunStats(
  runId: number,
  stats: Record<string, unknown>,
): Promise<void> {
  await getDb().update(runs).set({ stats }).where(eq(runs.id, runId));
}

/** Mark a running run as failed (orchestration-level error, not per-item). */
export async function failRun(runId: number, error: string): Promise<void> {
  await getPool().query(
    `UPDATE runs
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status = 'running'`,
    [runId, error],
  );
}

/**
 * Race-safe completion check: a single UPDATE that finishes the run only if
 * it is still 'running' and has no pending items (queued/planning/deferred).
 * Picks 'completed_with_errors' when any item failed. Returns true if the
 * run was finished by this call.
 */
export async function tryFinishRun(runId: number): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE runs
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM run_items
                 WHERE run_id = $1 AND status = 'failed'
              )
              THEN 'completed_with_errors'::run_status
              ELSE 'completed'::run_status
            END,
            finished_at = now()
      WHERE id = $1
        AND status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM run_items
           WHERE run_id = $1 AND status IN ('queued', 'planning', 'deferred')
        )`,
    [runId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Pause a run for a usage-limit window (idempotent; latest resumeAt wins). */
export async function pauseRun(runId: number, resumeAt: Date): Promise<void> {
  await getPool().query(
    `UPDATE runs
        SET status = 'paused_rate_limit', resume_at = $2
      WHERE id = $1 AND status IN ('running', 'paused_rate_limit')`,
    [runId, resumeAt],
  );
}

/**
 * Flip a paused run back to 'running'. With `onlyIfDue`, the resume only
 * applies once the run's resume_at has passed — a stale deduped resume-run
 * job from an earlier, shorter pause must not un-pause a re-paused run early.
 */
export async function resumeRun(
  runId: number,
  opts?: { onlyIfDue?: boolean },
): Promise<void> {
  const duePredicate = opts?.onlyIfDue
    ? "AND (resume_at IS NULL OR resume_at <= now())"
    : "";
  await getPool().query(
    `UPDATE runs
        SET status = 'running', resume_at = NULL
      WHERE id = $1 AND status = 'paused_rate_limit' ${duePredicate}`,
    [runId],
  );
}

// ---------------------------------------------------------------------------
// run_items
// ---------------------------------------------------------------------------

/** Insert a run item in status 'queued'; returns the run_item id. */
export async function createRunItem(runId: number, issueId: number): Promise<number> {
  const [row] = await getDb()
    .insert(runItems)
    .values({ runId, issueId })
    .returning({ id: runItems.id });
  if (!row) {
    throw new Error("failed to create run item");
  }
  return row.id;
}

export async function markRunItemPlanning(runItemId: number): Promise<void> {
  await getDb()
    .update(runItems)
    .set({ status: "planning", startedAt: new Date(), error: null })
    .where(eq(runItems.id, runItemId));
}

export async function markRunItemPlanned(
  runItemId: number,
  planId: number,
  agentStats: unknown,
): Promise<void> {
  await getDb()
    .update(runItems)
    .set({
      status: "planned",
      planId,
      agentStats,
      error: null,
      finishedAt: new Date(),
    })
    .where(eq(runItems.id, runItemId));
}

export async function markRunItemFailed(runItemId: number, error: string): Promise<void> {
  await getDb()
    .update(runItems)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(runItems.id, runItemId));
}

/** Usage-limit deferral: the item will be retried after the run resumes. */
export async function markRunItemDeferred(runItemId: number): Promise<void> {
  await getDb()
    .update(runItems)
    .set({ status: "deferred", finishedAt: null })
    .where(eq(runItems.id, runItemId));
}

export async function markRunItemSkipped(runItemId: number, reason?: string): Promise<void> {
  await getDb()
    .update(runItems)
    .set({ status: "skipped", error: reason ?? null, finishedAt: new Date() })
    .where(eq(runItems.id, runItemId));
}

/** Record an error message without changing status (pg-boss will retry). */
export async function setRunItemError(runItemId: number, error: string): Promise<void> {
  await getDb().update(runItems).set({ error }).where(eq(runItems.id, runItemId));
}

/** Sibling 'queued' items of a run (optionally excluding one item). */
export async function listQueuedRunItems(
  runId: number,
  excludeRunItemId?: number,
): Promise<Array<{ id: number; issueId: number }>> {
  return getDb()
    .select({ id: runItems.id, issueId: runItems.issueId })
    .from(runItems)
    .where(
      and(
        eq(runItems.runId, runId),
        eq(runItems.status, "queued"),
        excludeRunItemId === undefined ? undefined : ne(runItems.id, excludeRunItemId),
      ),
    );
}
