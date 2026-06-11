/**
 * Standup worker — queue orchestration.
 *
 * Boot order: verify env -> getBoss() (starts pg-boss + creates queues) ->
 * applySchedule() (morning-run cron from settings) -> schedule reaper ->
 * register handlers -> ready. Graceful shutdown stops pg-boss and closes the
 * db pool.
 *
 * Queues:
 * - morning-run:  sync enabled repos, pick plan candidates, fan out plan-issue
 * - plan-issue:   THE sequential AI queue (single worker, batchSize 1)
 * - execute-plan: run an approved plan (clone -> branch -> PR)
 * - resume-run:   internal — un-pause a run after a usage-limit window
 * - reaper:       internal cron (every 10 min) — requeue stuck items, fail
 *                 stuck executions, finish orphaned runs, re-apply schedule
 *
 * pg-boss v10: work() handlers receive an ARRAY of jobs (we use batchSize 1).
 *
 * Worker code only imports from src/lib/** and src/db/** (framework-agnostic).
 */
import type PgBoss from "pg-boss";
import { and, eq } from "drizzle-orm";

import { closePool, getDb, getPool } from "../src/db/client";
import { executions, plans, repos } from "../src/db/schema";
import { executeApprovedPlan } from "../src/lib/agent/executor";
import { isUsageLimitError } from "../src/lib/agent/limits";
import { generatePlanForIssue } from "../src/lib/agent/planner";
import { selectPlanCandidates, syncRepoIssues } from "../src/lib/issues-sync";
import { createDraftPlan } from "../src/lib/plans";
import {
  applySchedule,
  enqueueExecutePlanResume,
  enqueuePlanIssue,
  enqueueResumeRun,
  getBoss,
  INTERNAL_QUEUES,
  QUEUES,
  stopBoss,
  type ExecutePlanJobData,
  type MorningRunJobData,
  type PlanIssueJobData,
  type ResumeRunJobData,
} from "../src/lib/queue";
import {
  createRun,
  createRunItem,
  failRun,
  getRunById,
  listQueuedRunItems,
  markRunItemDeferred,
  markRunItemFailed,
  markRunItemPlanned,
  markRunItemPlanning,
  markRunItemSkipped,
  pauseRun,
  resumeRun,
  setRunItemError,
  tryFinishRun,
  updateRunStats,
} from "../src/lib/runs";
import { getMaxIssuesPerRun } from "../src/lib/settings";

const ONE_HOUR_MS = 60 * 60 * 1000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** UsageLimitError.resumeAt, falling back to one hour from now. */
function resolveResumeAt(err: unknown): Date {
  const resumeAt = (err as { resumeAt?: Date | null }).resumeAt ?? null;
  return resumeAt instanceof Date ? resumeAt : new Date(Date.now() + ONE_HOUR_MS);
}

// ---------------------------------------------------------------------------
// morning-run
// ---------------------------------------------------------------------------
async function handleMorningRun(job: PgBoss.Job<MorningRunJobData>): Promise<void> {
  const { trigger, triggeredBy } = job.data;
  const runId = await createRun(trigger, triggeredBy);
  console.log(`[worker] morning-run started (run ${runId}, trigger ${trigger})`);

  const stats = {
    repos_synced: 0,
    sync_errors: [] as Array<{ repo: string; error: string }>,
    issues_scanned: 0,
    queued: 0,
  };

  try {
    const enabledRepos = await getDb().select().from(repos).where(eq(repos.enabled, true));
    for (const repo of enabledRepos) {
      try {
        const res = await syncRepoIssues(repo.id);
        stats.repos_synced += 1;
        stats.issues_scanned += res.scanned;
      } catch (err) {
        const message = errMessage(err);
        console.error(`[worker] sync failed for ${repo.owner}/${repo.name}: ${message}`);
        stats.sync_errors.push({ repo: `${repo.owner}/${repo.name}`, error: message });
      }
    }

    const candidateIssueIds = await selectPlanCandidates(await getMaxIssuesPerRun());
    for (const issueId of candidateIssueIds) {
      const runItemId = await createRunItem(runId, issueId);
      const jobId = await enqueuePlanIssue({ runId, runItemId, issueId });
      if (jobId === null) {
        // A plan job for this issue is already pending (singleton dedupe).
        await markRunItemSkipped(runItemId, "a plan job for this issue is already queued");
      } else {
        stats.queued += 1;
      }
    }

    await updateRunStats(runId, stats);
    // No pending items (0 candidates, or all skipped) -> finishes immediately.
    await tryFinishRun(runId);
    console.log(
      `[worker] morning-run dispatched (run ${runId}): ${stats.repos_synced} repos synced, ` +
        `${stats.issues_scanned} issues scanned, ${stats.queued} queued, ` +
        `${stats.sync_errors.length} sync errors`,
    );
  } catch (err) {
    const message = errMessage(err);
    console.error(`[worker] morning-run failed (run ${runId}): ${message}`);
    await updateRunStats(runId, stats).catch(() => undefined);
    await failRun(runId, message);
    // Swallow: a pg-boss retry would create a duplicate run row.
  }
}

// ---------------------------------------------------------------------------
// plan-issue (sequential AI queue — registered with batchSize 1, single worker)
// ---------------------------------------------------------------------------
async function handlePlanIssue(job: PgBoss.JobWithMetadata<PlanIssueJobData>): Promise<void> {
  const { runId, runItemId, issueId } = job.data;

  const run = await getRunById(runId);
  if (!run) {
    console.warn(`[worker] plan-issue: run ${runId} not found, dropping job`);
    return;
  }
  if (run.status === "cancelled") {
    await markRunItemSkipped(runItemId, "run was cancelled");
    return;
  }
  if (run.status === "paused_rate_limit" && run.resumeAt) {
    if (run.resumeAt.getTime() > Date.now()) {
      // Run is paused: push this item past the resume point without burning
      // an agent call. Re-send works while this job is active ('short' policy
      // only blocks duplicates in 'created' state). A null send means ANOTHER
      // run's pending job already holds the per-issue singleton key — that job
      // carries a different runItemId, so this item would otherwise stay
      // 'queued' forever; mark it skipped instead.
      console.log(
        `[worker] plan-issue: run ${runId} paused, deferring issue ${issueId} ` +
          `until ${run.resumeAt.toISOString()}`,
      );
      const deferredJobId = await enqueuePlanIssue(
        { runId, runItemId, issueId },
        { startAfter: run.resumeAt },
      );
      if (deferredJobId === null) {
        await markRunItemSkipped(runItemId, "a plan job for this issue is already queued");
        await tryFinishRun(runId);
      }
      return;
    }
    // Resume point passed but the resume-run job was lost — self-heal.
    await resumeRun(runId);
  }

  try {
    await markRunItemPlanning(runItemId);
    const res = await generatePlanForIssue(issueId);

    // Pin the plan to the content hash the planner ACTUALLY consumed (returned
    // by generatePlanForIssue). Re-reading the issue row here would race with
    // concurrent syncs and record a hash for content the planner never saw,
    // making genuinely stale plans look fresh forever.
    const planId = await createDraftPlan(issueId, res.plan, res.markdown, res.basedOnHash);

    await markRunItemPlanned(runItemId, planId, res.stats);
    await tryFinishRun(runId);
    console.log(`[worker] planned issue ${issueId} -> plan ${planId} (run ${runId})`);
  } catch (err) {
    if (isUsageLimitError(err)) {
      const resumeAt = resolveResumeAt(err);
      console.warn(
        `[worker] usage limit while planning issue ${issueId}; pausing run ${runId} ` +
          `until ${resumeAt.toISOString()}`,
      );
      await markRunItemDeferred(runItemId);
      await pauseRun(runId, resumeAt);

      // Re-enqueue THIS item past the resume point (works while this job is
      // active). A null send means another run's pending job already holds the
      // per-issue singleton key with a different runItemId — mark this item
      // skipped so the run is not wedged forever.
      const resumeJobId = await enqueuePlanIssue({ runId, runItemId, issueId }, { startAfter: resumeAt });
      if (resumeJobId === null) {
        await markRunItemSkipped(runItemId, "a plan job for this issue is already queued");
      }
      // Sibling queued items: their singletonKeys dedupe against their own
      // already-pending jobs (the common case — null is expected and fine
      // there, the pending job carries the same runItemId and self-defers via
      // the paused-run check above).
      const siblings = await listQueuedRunItems(runId, runItemId);
      for (const sibling of siblings) {
        await enqueuePlanIssue(
          { runId, runItemId: sibling.id, issueId: sibling.issueId },
          { startAfter: resumeAt },
        );
      }

      await enqueueResumeRun(runId, resumeAt);
      // Return normally so pg-boss does NOT auto-retry before resumeAt.
      return;
    }

    const message = errMessage(err);
    console.error(`[worker] planning failed for issue ${issueId}: ${message}`);
    await setRunItemError(runItemId, message);

    const finalAttempt = job.retryCount >= job.retryLimit;
    if (finalAttempt) {
      await markRunItemFailed(runItemId, message);
      await tryFinishRun(runId);
    }
    // Rethrow so pg-boss retries (retryLimit 2 with backoff).
    throw err;
  }
}

// ---------------------------------------------------------------------------
// execute-plan
// ---------------------------------------------------------------------------
async function handleExecutePlan(job: PgBoss.Job<ExecutePlanJobData>): Promise<void> {
  const { executionId } = job.data;

  try {
    const res = await executeApprovedPlan(executionId);
    console.log(
      `[worker] execution ${executionId} opened PR ${res.prUrl} (branch ${res.branch})`,
    );
  } catch (err) {
    if (isUsageLimitError(err)) {
      const resumeAt = resolveResumeAt(err);
      console.warn(
        `[worker] usage limit during execution ${executionId}; retrying at ${resumeAt.toISOString()}`,
      );
      // The executor's catch marks the row 'failed' (+error/finishedAt) before
      // rethrowing — reset ALL of that so the row reads as cleanly re-queued.
      await getDb()
        .update(executions)
        .set({ status: "queued", startedAt: null, error: null, finishedAt: null })
        .where(eq(executions.id, executionId));
      // Distinct singletonKey suffix so the original job never dedupes it.
      await enqueueExecutePlanResume({ executionId }, resumeAt);
      return;
    }

    const message = errMessage(err);
    console.error(`[worker] execution ${executionId} failed: ${message}`);
    const [exec] = await getDb()
      .select()
      .from(executions)
      .where(eq(executions.id, executionId))
      .limit(1);
    await getDb()
      .update(executions)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(executions.id, executionId));
    if (exec) {
      // Hand the plan back to the user so they can retry.
      await getDb()
        .update(plans)
        .set({ status: "approved", updatedAt: new Date() })
        .where(and(eq(plans.id, exec.planId), eq(plans.status, "executing")));
    }
    // Never rethrow (retryLimit 0 anyway) — the failure is recorded in the db.
  }
}

// ---------------------------------------------------------------------------
// resume-run
// ---------------------------------------------------------------------------
async function handleResumeRun(job: PgBoss.Job<ResumeRunJobData>): Promise<void> {
  const { runId } = job.data;
  console.log(`[worker] resuming run ${runId} after usage-limit pause`);
  // onlyIfDue: a stale deduped resume-run job from an earlier, shorter pause
  // must not flip a re-paused run (with a later resume_at) back to 'running'.
  await resumeRun(runId, { onlyIfDue: true });
  await tryFinishRun(runId);
}

// ---------------------------------------------------------------------------
// reaper (internal cron, every 10 minutes)
// ---------------------------------------------------------------------------
async function handleReaper(): Promise<void> {
  const pool = getPool();

  // 1) run_items stuck in 'planning' > 30 min -> back to 'queued' + re-enqueue.
  try {
    const stuck = await pool.query(
      `UPDATE run_items
          SET status = 'queued', started_at = NULL
        WHERE status = 'planning'
          AND started_at < now() - interval '30 minutes'
        RETURNING id, run_id AS "runId", issue_id AS "issueId"`,
    );
    for (const row of stuck.rows) {
      console.warn(`[worker] reaper: requeueing stuck run_item ${row.id}`);
      const requeuedJobId = await enqueuePlanIssue({
        runId: Number(row.runId),
        runItemId: Number(row.id),
        issueId: Number(row.issueId),
      });
      if (requeuedJobId === null) {
        // Another run's pending job holds the per-issue singleton key (it
        // carries a different runItemId) — this item would stay 'queued'
        // forever with no job. Mirror the initial-enqueue behavior: skip it.
        await markRunItemSkipped(
          Number(row.id),
          "a plan job for this issue is already queued",
        );
        await tryFinishRun(Number(row.runId));
      }
    }
  } catch (err) {
    console.error("[worker] reaper: requeue of stuck run_items failed:", errMessage(err));
  }

  // 2) executions stuck in cloning/running/pushing > 90 min -> failed,
  //    plan back to 'approved'.
  try {
    const reaped = await pool.query(
      `UPDATE executions
          SET status = 'failed',
              error = 'reaped: stuck in ' || status || ' for over 90 minutes',
              finished_at = now()
        WHERE status IN ('cloning', 'running', 'pushing')
          AND COALESCE(started_at, created_at) < now() - interval '90 minutes'
        RETURNING id, plan_id AS "planId"`,
    );
    for (const row of reaped.rows) {
      console.warn(`[worker] reaper: failed stuck execution ${row.id}`);
      await pool.query(
        `UPDATE plans SET status = 'approved', updated_at = now()
          WHERE id = $1 AND status = 'executing'`,
        [row.planId],
      );
    }
  } catch (err) {
    console.error("[worker] reaper: stuck-execution sweep failed:", errMessage(err));
  }

  // 2b) executions stuck in 'queued' beyond a generous window (lost
  //     execute-plan job: enqueue failed after commit, or a usage-limit
  //     resume enqueue died). 24h is deliberately generous because usage-limit
  //     resumes legitimately wait hours. Plan goes back to 'approved' so the
  //     user can retry from the UI.
  try {
    const lost = await pool.query(
      `UPDATE executions
          SET status = 'failed',
              error = 'reaped: stuck in queued for over 24 hours (job lost)',
              finished_at = now()
        WHERE status = 'queued'
          AND COALESCE(started_at, created_at) < now() - interval '24 hours'
        RETURNING id, plan_id AS "planId"`,
    );
    for (const row of lost.rows) {
      console.warn(`[worker] reaper: failed lost queued execution ${row.id}`);
      await pool.query(
        `UPDATE plans SET status = 'approved', updated_at = now()
          WHERE id = $1 AND status = 'executing'`,
        [row.planId],
      );
    }
  } catch (err) {
    console.error("[worker] reaper: lost-queued-execution sweep failed:", errMessage(err));
  }

  // 3) paused runs whose resume point passed long ago (lost resume-run job).
  try {
    await pool.query(
      `UPDATE runs
          SET status = 'running', resume_at = NULL
        WHERE status = 'paused_rate_limit'
          AND resume_at IS NOT NULL
          AND resume_at < now() - interval '5 minutes'`,
    );
  } catch (err) {
    console.error("[worker] reaper: paused-run sweep failed:", errMessage(err));
  }

  // 4) finish any 'running' run with no pending items.
  try {
    const finishable = await pool.query(
      `SELECT r.id
         FROM runs r
        WHERE r.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM run_items ri
             WHERE ri.run_id = r.id
               AND ri.status IN ('queued', 'planning', 'deferred')
          )`,
    );
    for (const row of finishable.rows) {
      await tryFinishRun(Number(row.id));
    }
  } catch (err) {
    console.error("[worker] reaper: run-finish sweep failed:", errMessage(err));
  }

  // 5) re-apply the morning-run schedule so settings changes take effect
  //    within 10 minutes.
  try {
    await applySchedule();
  } catch (err) {
    console.error("[worker] reaper: applySchedule failed:", errMessage(err));
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("[worker] booting standup worker");

  if (!process.env.DATABASE_URL) {
    console.error("[worker] DATABASE_URL is not set — exiting");
    process.exit(1);
  }
  if (!process.env.SECRETS_ENCRYPTION_KEY) {
    console.warn(
      "[worker] SECRETS_ENCRYPTION_KEY is not set — secret-backed settings will rely on env fallbacks",
    );
  }

  let boss: PgBoss;
  try {
    boss = await getBoss();
    await boss.schedule(INTERNAL_QUEUES.reaper, "*/10 * * * *", {}, { tz: "UTC" });
  } catch (err) {
    console.error("[worker] failed to start pg-boss:", err);
    process.exit(1);
  }

  // Non-fatal: a bad schedule_cron settings value must not crash-loop the
  // worker at boot (the settings UI validates, but defense in depth). The
  // reaper re-applies the schedule every 10 minutes, so a later fix to the
  // settings row takes effect without a restart.
  try {
    await applySchedule();
  } catch (err) {
    console.error(
      "[worker] applySchedule failed at boot (continuing — reaper retries every 10 min):",
      errMessage(err),
    );
  }

  // pg-boss v10 work() handlers receive an ARRAY of jobs — batchSize 1 keeps
  // each queue sequential within this process (plan-issue concurrency 1).
  await boss.work<MorningRunJobData>(QUEUES.morningRun, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleMorningRun(job);
    }
  });

  await boss.work<PlanIssueJobData>(
    QUEUES.planIssue,
    { batchSize: 1, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        await handlePlanIssue(job);
      }
    },
  );

  await boss.work<ExecutePlanJobData>(QUEUES.executePlan, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleExecutePlan(job);
    }
  });

  await boss.work<ResumeRunJobData>(INTERNAL_QUEUES.resumeRun, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleResumeRun(job);
    }
  });

  await boss.work(INTERNAL_QUEUES.reaper, { batchSize: 1 }, async () => {
    await handleReaper();
  });

  console.log(
    "[worker] worker ready — handlers: morning-run, plan-issue (seq), " +
      "execute-plan, resume-run, reaper (*/10)",
  );

  // Keep the process alive until a signal arrives.
  const keepAlive = setInterval(() => {
    /* noop heartbeat */
  }, 60_000);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down`);
    clearInterval(keepAlive);
    try {
      await stopBoss();
    } catch (err) {
      console.error("[worker] error stopping pg-boss:", err);
    }
    try {
      await closePool();
    } catch (err) {
      console.error("[worker] error closing db pool:", err);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

void main();
