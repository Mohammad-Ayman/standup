"use server";

/**
 * Server actions for the dashboard + plan review surface.
 *
 * EVERY action: (1) auth gate, (2) zod-validate inputs at the boundary,
 * (3) call the framework-agnostic lib function with the db user id,
 * (4) revalidate the affected routes.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { auth } from "@/auth";
import {
  approvePlan,
  editPlan,
  rejectPlan,
  requestExecution,
} from "@/lib/plans";
import { triggerPlanNow } from "@/lib/run-triggers";

const IdZ = z.number().int().positive();
const ContentMdZ = z.string().min(1, "plan content cannot be empty").max(200_000);
const ReasonZ = z.string().max(10_000).optional();

async function requireUserId(): Promise<number> {
  const session = await auth();
  if (!session?.user) throw new Error("unauthenticated");
  return Number(session.user.id);
}

/** Revalidate the dashboard plus every issue detail page. */
function revalidateIssueViews(): void {
  revalidatePath("/");
  revalidatePath("/issues/[id]", "page");
}

/** Save an edited plan as a new user-authored version (approved → draft). */
export async function saveEditAction(
  planId: number,
  contentMd: string,
): Promise<void> {
  const userId = await requireUserId();
  await editPlan(IdZ.parse(planId), ContentMdZ.parse(contentMd), userId);
  revalidateIssueViews();
}

export async function approveAction(planId: number): Promise<void> {
  const userId = await requireUserId();
  await approvePlan(IdZ.parse(planId), userId);
  revalidateIssueViews();
}

export async function rejectAction(
  planId: number,
  reason?: string,
): Promise<void> {
  const userId = await requireUserId();
  const parsedReason = ReasonZ.parse(reason);
  await rejectPlan(
    IdZ.parse(planId),
    userId,
    parsedReason && parsedReason.trim().length > 0 ? parsedReason : undefined,
  );
  revalidateIssueViews();
}

/** Queue execution of an approved plan; returns the executions row id. */
export async function executeAction(planId: number): Promise<number> {
  const userId = await requireUserId();
  const executionId = await requestExecution(IdZ.parse(planId), userId);
  revalidateIssueViews();
  return executionId;
}

/** Plan (or replan) a single issue right now via a manual single-item run. */
export async function planNowAction(issueId: number): Promise<void> {
  const userId = await requireUserId();
  await triggerPlanNow(IdZ.parse(issueId), userId);
  revalidateIssueViews();
  revalidatePath("/runs");
}

// "Run now" lives in @/app/actions/runs (single canonical runNowAction).
