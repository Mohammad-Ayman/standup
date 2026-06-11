/**
 * Plan lifecycle — draft / edit / approve / reject / request execution.
 *
 * All mutations run inside db.transaction(). Status transitions are asserted
 * with row locks (SELECT ... FOR UPDATE) so concurrent dashboard actions
 * cannot race each other.
 *
 * Framework-agnostic: no next/react imports allowed here.
 */
import { and, eq, inArray, max } from "drizzle-orm";

import { getDb } from "../db/client";
import { executions, plans, planVersions } from "../db/schema";
import type { Plan } from "./agent/plan-schema";
import { enqueueExecutePlan } from "./queue";

/** Walk err.cause chain looking for a Postgres unique violation (23505). */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === "object") {
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Insert a new draft plan + v1 plan_version (author 'agent').
 *
 * Active-plan handling (one_active_plan_per_issue partial unique index):
 * - executing plan        -> never replaced; its id is returned (the fresh
 *                            plan content is discarded — execution in flight)
 * - draft/approved with the SAME based_on_hash -> dedupe; existing id returned
 * - draft/approved with a DIFFERENT hash -> superseded atomically, then the
 *   new draft is inserted (this is the "Replan a stale plan" path — without
 *   it the freshly generated plan would be silently discarded)
 */
export async function createDraftPlan(
  issueId: number,
  plan: Plan,
  markdown: string,
  basedOnHash: string,
): Promise<number> {
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [active] = await tx
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.issueId, issueId),
            inArray(plans.status, ["draft", "approved", "executing"]),
          ),
        )
        .for("update");
      if (active) {
        if (active.status === "executing" || active.basedOnHash === basedOnHash) {
          return active.id;
        }
        // Stale draft/approved plan — replace it with the fresh one.
        await tx
          .update(plans)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(eq(plans.id, active.id));
      }

      const [planRow] = await tx
        .insert(plans)
        .values({
          issueId,
          status: "draft",
          basedOnHash,
          updatedAt: new Date(),
        })
        .returning({ id: plans.id });
      const [versionRow] = await tx
        .insert(planVersions)
        .values({
          planId: planRow.id,
          version: 1,
          contentMd: markdown,
          metadata: plan,
          authorType: "agent",
        })
        .returning({ id: planVersions.id });
      await tx
        .update(plans)
        .set({ currentVersionId: versionRow.id })
        .where(eq(plans.id, planRow.id));
      return planRow.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [existing] = await db
        .select({ id: plans.id })
        .from(plans)
        .where(
          and(
            eq(plans.issueId, issueId),
            inArray(plans.status, ["draft", "approved", "executing"]),
          ),
        )
        .limit(1);
      if (existing) {
        return existing.id;
      }
    }
    throw err;
  }
}

/**
 * Append a user-authored version and make it current.
 * Editing an approved plan resets it to draft (re-approval required).
 */
export async function editPlan(
  planId: number,
  contentMd: string,
  userId: number,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, planId))
      .for("update");
    if (!plan) {
      throw new Error(`plan ${planId} not found`);
    }
    if (plan.status !== "draft" && plan.status !== "approved") {
      throw new Error(`cannot edit plan in status '${plan.status}'`);
    }

    const [agg] = await tx
      .select({ maxVersion: max(planVersions.version) })
      .from(planVersions)
      .where(eq(planVersions.planId, planId));
    const nextVersion = (agg?.maxVersion ?? 0) + 1;

    const [versionRow] = await tx
      .insert(planVersions)
      .values({
        planId,
        version: nextVersion,
        contentMd,
        authorType: "user",
        authorUserId: userId,
      })
      .returning({ id: planVersions.id });

    const set: Partial<typeof plans.$inferInsert> = {
      currentVersionId: versionRow.id,
      updatedAt: new Date(),
    };
    if (plan.status === "approved") {
      set.status = "draft";
      set.approvedBy = null;
      set.approvedAt = null;
    }
    await tx.update(plans).set(set).where(eq(plans.id, planId));
  });
}

export async function approvePlan(planId: number, userId: number): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, planId))
      .for("update");
    if (!plan) {
      throw new Error(`plan ${planId} not found`);
    }
    if (plan.status !== "draft") {
      throw new Error(
        `cannot approve plan in status '${plan.status}' (expected 'draft')`,
      );
    }
    const now = new Date();
    await tx
      .update(plans)
      .set({
        status: "approved",
        approvedBy: userId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(eq(plans.id, planId));
  });
}

export async function rejectPlan(
  planId: number,
  userId: number,
  reason?: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, planId))
      .for("update");
    if (!plan) {
      throw new Error(`plan ${planId} not found`);
    }
    if (plan.status !== "draft" && plan.status !== "approved") {
      throw new Error(
        `cannot reject plan in status '${plan.status}' (expected 'draft' or 'approved')`,
      );
    }
    const now = new Date();
    await tx
      .update(plans)
      .set({
        status: "rejected",
        rejectedBy: userId,
        rejectedAt: now,
        rejectReason: reason ?? null,
        updatedAt: now,
      })
      .where(eq(plans.id, planId));
  });
}

/**
 * Queue execution of an approved plan: insert an executions row (queued,
 * pinned to the plan's current version), flip the plan to 'executing', then
 * enqueue the execute-plan job. Returns the executions row id.
 */
export async function requestExecution(
  planId: number,
  userId: number,
): Promise<number> {
  const db = getDb();
  const executionId = await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, planId))
      .for("update");
    if (!plan) {
      throw new Error(`plan ${planId} not found`);
    }
    if (plan.status !== "approved") {
      throw new Error(
        `cannot execute plan in status '${plan.status}' (expected 'approved')`,
      );
    }
    if (plan.currentVersionId === null) {
      throw new Error(`plan ${planId} has no current version`);
    }

    const [execution] = await tx
      .insert(executions)
      .values({
        planId,
        planVersionId: plan.currentVersionId,
        issueId: plan.issueId,
        status: "queued",
        requestedBy: userId,
      })
      .returning({ id: executions.id });

    await tx
      .update(plans)
      .set({ status: "executing", updatedAt: new Date() })
      .where(eq(plans.id, planId));

    return execution.id;
  });

  // Enqueue after commit so a rolled-back transaction never leaves a job.
  await enqueueExecutePlan({ executionId });
  return executionId;
}
