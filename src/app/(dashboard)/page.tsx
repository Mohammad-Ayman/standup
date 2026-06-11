/**
 * Dashboard — latest run banner, "Run now", and all open issues grouped by
 * plan state (needs review / approved / executing / executed / failed /
 * no plan yet).
 */
import { desc, eq, isNotNull } from "drizzle-orm";

import { runNowAction } from "@/app/actions/runs";
import { PlanCard, type IssueListItem } from "@/components/plan-card";
import { RunBanner } from "@/components/run-banner";
import { getDb } from "@/db/client";
import {
  executions,
  issues,
  plans,
  repos,
  runs,
  type PlanRow,
} from "@/db/schema";

export const dynamic = "force-dynamic";

type GroupKey =
  | "needs_review"
  | "approved"
  | "executing"
  | "executed"
  | "failed"
  | "no_plan";

const GROUPS: Array<{ key: GroupKey; title: string; hint?: string }> = [
  { key: "needs_review", title: "Needs review", hint: "draft plans waiting for you" },
  { key: "approved", title: "Approved", hint: "ready to execute" },
  { key: "executing", title: "Executing" },
  { key: "executed", title: "Executed" },
  { key: "failed", title: "Failed" },
  { key: "no_plan", title: "No plan yet" },
];

function groupForPlanStatus(status: string | null): GroupKey {
  switch (status) {
    case "draft":
      return "needs_review";
    case "approved":
      return "approved";
    case "executing":
      return "executing";
    case "executed":
      return "executed";
    case "failed":
      return "failed";
    // rejected / superseded / none — the issue has no active plan.
    default:
      return "no_plan";
  }
}

export default async function DashboardPage() {
  const db = getDb();

  const [latestRun] = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.id))
    .limit(1);

  const issueRows = await db
    .select({ issue: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .where(eq(issues.state, "open"))
    .orderBy(desc(issues.githubUpdatedAt));

  const planRows = await db.select().from(plans).orderBy(desc(plans.id));
  const latestPlanByIssue = new Map<number, PlanRow>();
  for (const plan of planRows) {
    if (!latestPlanByIssue.has(plan.issueId)) {
      latestPlanByIssue.set(plan.issueId, plan);
    }
  }

  const prRows = await db
    .select({ planId: executions.planId, prUrl: executions.prUrl })
    .from(executions)
    .where(isNotNull(executions.prUrl))
    .orderBy(desc(executions.id));
  const prUrlByPlan = new Map<number, string>();
  for (const row of prRows) {
    if (row.prUrl && !prUrlByPlan.has(row.planId)) {
      prUrlByPlan.set(row.planId, row.prUrl);
    }
  }

  const grouped: Record<GroupKey, IssueListItem[]> = {
    needs_review: [],
    approved: [],
    executing: [],
    executed: [],
    failed: [],
    no_plan: [],
  };

  for (const { issue, repo } of issueRows) {
    const plan = latestPlanByIssue.get(issue.id) ?? null;
    const group = groupForPlanStatus(plan?.status ?? null);
    grouped[group].push({
      issueId: issue.id,
      repo: `${repo.owner}/${repo.name}`,
      number: issue.number,
      title: issue.title,
      labels: Array.isArray(issue.labels) ? (issue.labels as string[]) : [],
      planStatus: plan?.status ?? null,
      stale: plan !== null && plan.basedOnHash !== issue.contentHash,
      prUrl: plan ? (prUrlByPlan.get(plan.id) ?? null) : null,
      updatedAt: issue.githubUpdatedAt,
    });
  }

  const totalIssues = issueRows.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {totalIssues} open issue{totalIssues === 1 ? "" : "s"} across your
            watched repos
          </p>
        </div>
        <form action={runNowAction}>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
          >
            Run now
          </button>
        </form>
      </div>

      <RunBanner run={latestRun ?? null} />

      {totalIssues === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center text-sm text-zinc-500">
          No open issues synced yet. Add repos in Settings, then press Run now.
        </div>
      ) : (
        GROUPS.map(({ key, title, hint }) => {
          const items = grouped[key];
          if (items.length === 0) return null;
          return (
            <section key={key}>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
                <span className="rounded-full bg-zinc-200/70 px-2 py-0.5 text-xs font-medium text-zinc-600">
                  {items.length}
                </span>
                {hint ? (
                  <span className="text-xs text-zinc-400">{hint}</span>
                ) : null}
              </div>
              <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
                {items.map((item) => (
                  <PlanCard key={item.issueId} item={item} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
