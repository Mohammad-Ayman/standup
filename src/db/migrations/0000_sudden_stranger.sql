CREATE TYPE "public"."execution_status" AS ENUM('queued', 'cloning', 'running', 'pushing', 'pr_opened', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'approved', 'rejected', 'superseded', 'executing', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_item_status" AS ENUM('queued', 'planning', 'planned', 'skipped', 'failed', 'deferred');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'completed', 'completed_with_errors', 'paused_rate_limit', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "allowlist" (
	"login" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "execution_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"execution_id" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now(),
	"stream" text DEFAULT 'agent',
	"line" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" bigint NOT NULL,
	"plan_version_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"status" "execution_status" DEFAULT 'queued' NOT NULL,
	"branch_name" text,
	"commit_sha" text,
	"pr_url" text,
	"pr_number" integer,
	"error" text,
	"requested_by" bigint,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"github_issue_id" bigint,
	"number" integer,
	"title" text,
	"body" text,
	"state" text,
	"labels" jsonb DEFAULT '[]'::jsonb,
	"author_login" text,
	"comments_count" integer DEFAULT 0,
	"github_updated_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "issues_github_issue_id_unique" UNIQUE("github_issue_id"),
	CONSTRAINT "issues_repo_id_number_unique" UNIQUE("repo_id","number")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"content_md" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"author_type" text NOT NULL,
	"author_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "plan_versions_plan_id_version_unique" UNIQUE("plan_id","version")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issue_id" bigint NOT NULL,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" bigint,
	"based_on_hash" text NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"rejected_by" bigint,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id"),
	CONSTRAINT "repos_owner_name_unique" UNIQUE("owner","name")
);
--> statement-breakpoint
CREATE TABLE "run_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"status" "run_item_status" DEFAULT 'queued' NOT NULL,
	"plan_id" bigint,
	"error" text,
	"agent_stats" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_items_run_id_issue_id_unique" UNIQUE("run_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by" bigint,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb,
	"resume_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"secret_ciphertext" text,
	"is_secret" boolean DEFAULT false,
	"updated_by" bigint,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_login_unique" UNIQUE("login")
);
--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_logs_execution_id_id_idx" ON "execution_logs" USING btree ("execution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_plan_per_issue" ON "plans" USING btree ("issue_id") WHERE "plans"."status" in ('draft', 'approved', 'executing');