"use server";

/**
 * Server actions for the runs page.
 */
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { triggerRunNow } from "@/lib/run-triggers";

async function requireUserId(): Promise<number> {
  const session = await auth();
  const id = Number(session?.user?.id);
  if (!session?.user?.id || !Number.isInteger(id) || id <= 0) {
    throw new Error("Unauthorized");
  }
  return id;
}

/**
 * "Run now" — enqueue a manual morning run. Deduped by pg-boss: pressing it
 * twice while one is still pending is a no-op.
 */
export async function runNowAction(): Promise<void> {
  const userId = await requireUserId();
  await triggerRunNow(userId);
  revalidatePath("/");
  revalidatePath("/runs");
}
