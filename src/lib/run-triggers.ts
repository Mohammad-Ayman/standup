/**
 * UI-facing run triggers — thin helpers the dashboard server actions call.
 *
 * Framework-agnostic: no next/react imports.
 */
import { enqueueMorningRun, enqueuePlanIssue } from "./queue";
import {
  createRun,
  createRunItem,
  markRunItemSkipped,
  tryFinishRun,
  updateRunStats,
} from "./runs";

/**
 * "Run now" button — enqueue a manual morning run. Deduped by pg-boss
 * (singletonKey 'morning-run'): pressing it twice while one is pending is a
 * no-op.
 */
export async function triggerRunNow(userId: number): Promise<void> {
  await enqueueMorningRun("manual", userId);
}

/**
 * "Plan this issue now" button — create a manual run with a single run item
 * and enqueue planning for it. If a plan job for the issue is already pending
 * (singleton dedupe), the item is marked skipped and the run finishes
 * immediately instead of hanging forever.
 */
export async function triggerPlanNow(issueId: number, userId: number): Promise<void> {
  const runId = await createRun("manual", userId);
  const runItemId = await createRunItem(runId, issueId);
  const jobId = await enqueuePlanIssue({ runId, runItemId, issueId });

  if (jobId === null) {
    await markRunItemSkipped(runItemId, "a plan job for this issue is already queued");
    await updateRunStats(runId, {
      repos_synced: 0,
      sync_errors: [],
      issues_scanned: 0,
      queued: 0,
    });
    await tryFinishRun(runId);
    return;
  }

  await updateRunStats(runId, {
    repos_synced: 0,
    sync_errors: [],
    issues_scanned: 0,
    queued: 1,
  });
}
