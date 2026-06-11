/**
 * Standup worker — M0 stub.
 *
 * Boots pg-boss against DATABASE_URL and stays alive. Real queue/cron handlers
 * (sync, planner, executor) land in later phases.
 *
 * Worker code only imports from src/lib/** and src/db/** (framework-agnostic).
 */
import PgBoss from "pg-boss";

import { closePool } from "../src/db/client";

async function main(): Promise<void> {
  console.log("[worker] booting standup worker");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[worker] DATABASE_URL is not set — exiting");
    process.exit(1);
  }

  let boss: PgBoss;
  try {
    boss = new PgBoss(connectionString);
    boss.on("error", (err) => {
      console.error("[worker] pg-boss error:", err);
    });
    await boss.start();
  } catch (err) {
    console.error("[worker] failed to start pg-boss:", err);
    process.exit(1);
  }

  // TODO(M2+): register queues
  // - sync:    cron — fetch open issues from watched repos (Octokit)
  // - plan:    generate a per-issue solving plan via the Claude Agent SDK
  // - execute: run approved plans (ephemeral clone -> branch -> PR)

  console.log("[worker] worker ready");

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
      await boss.stop();
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
