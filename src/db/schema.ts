/**
 * Standup database schema — THE central contract for all later phases
 * (sync worker, planner, executor, dashboard UI).
 *
 * Conventions:
 * - snake_case column names, camelCase TS fields
 * - bigserial primary keys
 * - timestamptz timestamps (withTimezone)
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).unique().notNull(),
  login: text("login").unique().notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// allowlist — GitHub logins allowed to sign in (store lowercased)
// ---------------------------------------------------------------------------
export const allowlist = pgTable("allowlist", {
  login: text("login").primaryKey(),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// settings — key/value store; secrets live encrypted in secret_ciphertext
// ---------------------------------------------------------------------------
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  secretCiphertext: text("secret_ciphertext"),
  isSecret: boolean("is_secret").default(false),
  updatedBy: bigint("updated_by", { mode: "number" }).references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// repos — watched GitHub repositories
// ---------------------------------------------------------------------------
export const repos = pgTable(
  "repos",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).unique().notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    enabled: boolean("enabled").default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique("repos_owner_name_unique").on(t.owner, t.name)],
);

// ---------------------------------------------------------------------------
// issues — synced GitHub issues
// ---------------------------------------------------------------------------
export const issues = pgTable(
  "issues",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: bigint("repo_id", { mode: "number" })
      .references(() => repos.id, { onDelete: "cascade" })
      .notNull(),
    githubIssueId: bigint("github_issue_id", { mode: "number" }).unique(),
    number: integer("number"),
    title: text("title"),
    body: text("body"),
    state: text("state", { enum: ["open", "closed"] }),
    labels: jsonb("labels").default([]),
    authorLogin: text("author_login"),
    commentsCount: integer("comments_count").default(0),
    githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }).notNull(),
    contentHash: text("content_hash").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique("issues_repo_id_number_unique").on(t.repoId, t.number)],
);

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------
export const planStatus = pgEnum("plan_status", [
  "draft",
  "approved",
  "rejected",
  "superseded",
  "executing",
  "executed",
  "failed",
]);

export const plans = pgTable(
  "plans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    issueId: bigint("issue_id", { mode: "number" })
      .references(() => issues.id, { onDelete: "cascade" })
      .notNull(),
    status: planStatus("status").default("draft").notNull(),
    // Plain column (no FK) to avoid a FK cycle with plan_versions.
    currentVersionId: bigint("current_version_id", { mode: "number" }),
    basedOnHash: text("based_on_hash").notNull(),
    approvedBy: bigint("approved_by", { mode: "number" }).references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: bigint("rejected_by", { mode: "number" }).references(() => users.id),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("one_active_plan_per_issue")
      .on(t.issueId)
      .where(sql`${t.status} in ('draft', 'approved', 'executing')`),
  ],
);

// ---------------------------------------------------------------------------
// plan_versions — immutable content versions of a plan
// ---------------------------------------------------------------------------
export const planVersions = pgTable(
  "plan_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    planId: bigint("plan_id", { mode: "number" })
      .references(() => plans.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    contentMd: text("content_md").notNull(),
    metadata: jsonb("metadata").default({}),
    authorType: text("author_type", { enum: ["agent", "user"] }).notNull(),
    authorUserId: bigint("author_user_id", { mode: "number" }).references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique("plan_versions_plan_id_version_unique").on(t.planId, t.version)],
);

// ---------------------------------------------------------------------------
// runs — one morning sync/planning run (cron or manual)
// ---------------------------------------------------------------------------
export const runStatus = pgEnum("run_status", [
  "running",
  "completed",
  "completed_with_errors",
  "paused_rate_limit",
  "failed",
  "cancelled",
]);

export const runs = pgTable("runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  trigger: text("trigger", { enum: ["cron", "manual"] }).notNull(),
  triggeredBy: bigint("triggered_by", { mode: "number" }).references(() => users.id),
  status: runStatus("status").default("running").notNull(),
  stats: jsonb("stats").default({}),
  resumeAt: timestamp("resume_at", { withTimezone: true }),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// run_items — per-issue progress within a run
// ---------------------------------------------------------------------------
export const runItemStatus = pgEnum("run_item_status", [
  "queued",
  "planning",
  "planned",
  "skipped",
  "failed",
  "deferred",
]);

export const runItems = pgTable(
  "run_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    issueId: bigint("issue_id", { mode: "number" })
      .references(() => issues.id, { onDelete: "cascade" })
      .notNull(),
    status: runItemStatus("status").default("queued").notNull(),
    planId: bigint("plan_id", { mode: "number" }).references(() => plans.id),
    error: text("error"),
    agentStats: jsonb("agent_stats"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [unique("run_items_run_id_issue_id_unique").on(t.runId, t.issueId)],
);

// ---------------------------------------------------------------------------
// executions — executor runs for approved plans (clone -> branch -> PR)
// ---------------------------------------------------------------------------
export const executionStatus = pgEnum("execution_status", [
  "queued",
  "cloning",
  "running",
  "pushing",
  "pr_opened",
  "failed",
  "cancelled",
]);

export const executions = pgTable("executions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  planId: bigint("plan_id", { mode: "number" })
    .references(() => plans.id)
    .notNull(),
  planVersionId: bigint("plan_version_id", { mode: "number" })
    .references(() => planVersions.id)
    .notNull(),
  issueId: bigint("issue_id", { mode: "number" })
    .references(() => issues.id)
    .notNull(),
  status: executionStatus("status").default("queued").notNull(),
  branchName: text("branch_name"),
  commitSha: text("commit_sha"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  error: text("error"),
  requestedBy: bigint("requested_by", { mode: "number" }).references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// execution_logs — streamed log lines for an execution
// ---------------------------------------------------------------------------
export const executionLogs = pgTable(
  "execution_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    executionId: bigint("execution_id", { mode: "number" })
      .references(() => executions.id, { onDelete: "cascade" })
      .notNull(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow(),
    stream: text("stream", { enum: ["agent", "git", "system"] }).default("agent"),
    line: text("line").notNull(),
  },
  (t) => [index("execution_logs_execution_id_id_idx").on(t.executionId, t.id)],
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------
export type UserRow = typeof users.$inferSelect;
export type AllowlistRow = typeof allowlist.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type RepoRow = typeof repos.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunItemRow = typeof runItems.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type ExecutionLogRow = typeof executionLogs.$inferSelect;

export type NewUserRow = typeof users.$inferInsert;
export type NewRepoRow = typeof repos.$inferInsert;
export type NewIssueRow = typeof issues.$inferInsert;
export type NewPlanRow = typeof plans.$inferInsert;
export type NewPlanVersionRow = typeof planVersions.$inferInsert;
export type NewRunRow = typeof runs.$inferInsert;
export type NewRunItemRow = typeof runItems.$inferInsert;
export type NewExecutionRow = typeof executions.$inferInsert;
export type NewExecutionLogRow = typeof executionLogs.$inferInsert;
