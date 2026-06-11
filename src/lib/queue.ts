/**
 * pg-boss queue layer — singleton boss instance + typed enqueue helpers.
 *
 * pg-boss v10 notes:
 * - Queues MUST be created (boss.createQueue) before send()/work(); we create
 *   every queue right after start() inside the singleton initializer.
 * - Queue policy 'short' = at most ONE job in 'created' state per singleton
 *   key. That is what gives our singletonKey sends their dedupe semantics
 *   (send() returns null when an identical pending job already exists), while
 *   still allowing a handler to re-enqueue its own job while it is 'active'
 *   (used for usage-limit deferral).
 *
 * Framework-agnostic: no next/react imports (worker imports this).
 */
import PgBoss from "pg-boss";

import { getSchedule } from "./settings";

export const QUEUES = {
  morningRun: "morning-run",
  planIssue: "plan-issue",
  executePlan: "execute-plan",
} as const;

/** Internal queues owned by the worker (resume + reaper). */
export const INTERNAL_QUEUES = {
  resumeRun: "resume-run",
  reaper: "reaper",
} as const;

// ---------------------------------------------------------------------------
// Job payload types (shared by enqueue helpers and worker handlers)
// ---------------------------------------------------------------------------
export type MorningRunJobData = {
  trigger: "cron" | "manual";
  triggeredBy?: number;
};

export type PlanIssueJobData = {
  runId: number;
  runItemId: number;
  issueId: number;
};

export type ExecutePlanJobData = {
  executionId: number;
};

export type ResumeRunJobData = {
  runId: number;
};

// ---------------------------------------------------------------------------
// Singleton boss
// ---------------------------------------------------------------------------
let bossPromise: Promise<PgBoss> | undefined;

async function startBoss(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const boss = new PgBoss(connectionString);
  boss.on("error", (err) => {
    console.error("[queue] pg-boss error:", err);
  });
  await boss.start();

  // v10: every queue must exist before send/work.
  const queues: Array<{ name: string; policy: PgBoss.QueuePolicy }> = [
    { name: QUEUES.morningRun, policy: "short" },
    { name: QUEUES.planIssue, policy: "short" },
    { name: QUEUES.executePlan, policy: "short" },
    { name: INTERNAL_QUEUES.resumeRun, policy: "short" },
    { name: INTERNAL_QUEUES.reaper, policy: "standard" },
  ];
  for (const q of queues) {
    await boss.createQueue(q.name, { name: q.name, policy: q.policy });
  }

  return boss;
}

/** Started pg-boss singleton; all queues are created before this resolves. */
export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const starting = startBoss();
    bossPromise = starting;
    // Allow a later retry if boot fails (e.g. DB briefly unreachable).
    starting.catch(() => {
      if (bossPromise === starting) {
        bossPromise = undefined;
      }
    });
  }
  return bossPromise;
}

/** Graceful shutdown helper — stops the singleton if it was ever started. */
export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const current = bossPromise;
  bossPromise = undefined;
  const boss = await current.catch(() => undefined);
  if (boss) {
    await boss.stop({ graceful: true, wait: true });
  }
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a morning run. singletonKey 'morning-run' + 'short' policy means a
 * second send while one is still pending returns null (skipped).
 */
export async function enqueueMorningRun(
  trigger: "cron" | "manual",
  triggeredBy?: number,
): Promise<string | null> {
  const boss = await getBoss();
  const data: MorningRunJobData =
    triggeredBy === undefined ? { trigger } : { trigger, triggeredBy };
  return boss.send(QUEUES.morningRun, data, { singletonKey: "morning-run" });
}

/**
 * Enqueue planning for one issue. Deduped per issue via singletonKey
 * plan-<issueId>; returns null when an identical pending job exists.
 */
export async function enqueuePlanIssue(
  data: { runId: number; runItemId: number; issueId: number },
  opts?: { startAfter?: Date },
): Promise<string | null> {
  const boss = await getBoss();
  const options: PgBoss.SendOptions = {
    singletonKey: `plan-${data.issueId}`,
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  };
  if (opts?.startAfter) {
    options.startAfter = opts.startAfter;
  }
  return boss.send(QUEUES.planIssue, data, options);
}

/** Enqueue execution of an approved plan. No retries — failures are surfaced. */
export async function enqueueExecutePlan(data: {
  executionId: number;
}): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUES.executePlan, data, {
    singletonKey: `exec-${data.executionId}`,
    retryLimit: 0,
    expireInSeconds: 3600,
  });
}

/**
 * Re-enqueue an execution after a usage-limit deferral. Uses a distinct
 * singletonKey suffix so the original (active/completed) job never dedupes it.
 */
export async function enqueueExecutePlanResume(
  data: ExecutePlanJobData,
  startAfter: Date,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUES.executePlan, data, {
    singletonKey: `exec-${data.executionId}-resume-${startAfter.getTime()}`,
    retryLimit: 0,
    expireInSeconds: 3600,
    startAfter,
  });
}

/**
 * Schedule a 'resume-run' job that flips a paused run back to 'running' once
 * the usage-limit window has passed. Deduped per run while one is pending.
 */
export async function enqueueResumeRun(
  runId: number,
  startAfter: Date,
): Promise<string | null> {
  const boss = await getBoss();
  const data: ResumeRunJobData = { runId };
  return boss.send(INTERNAL_QUEUES.resumeRun, data, {
    singletonKey: `resume-run-${runId}`,
    retryLimit: 2,
    retryDelay: 60,
    startAfter,
  });
}

/**
 * (Re-)apply the morning-run cron schedule from settings. boss.schedule
 * upserts by queue name, so calling this repeatedly is safe; the reaper
 * re-calls it every 10 minutes so settings changes take effect quickly.
 */
export async function applySchedule(): Promise<void> {
  const boss = await getBoss();
  const { cron, tz } = await getSchedule();
  await boss.schedule(QUEUES.morningRun, cron, { trigger: "cron" }, { tz });
}
