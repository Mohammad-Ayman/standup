/**
 * Issue detail — issue header + body, the interactive plan panel (review /
 * edit / approve / reject / execute / replan + version history), and the
 * execution history for this issue.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";

import { relativeTime } from "@/components/format";
import { MarkdownView } from "@/components/markdown-view";
import {
  PlanPanel,
  type PlanPanelPlan,
  type PlanPanelVersion,
} from "@/components/plan-panel";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/db/client";
import { executions, issues, planVersions, plans, repos } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idRaw } = await params;
  const issueId = Number(idRaw);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    notFound();
  }

  const db = getDb();
  const [row] = await db
    .select({ issue: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) {
    notFound();
  }
  const { issue, repo } = row;

  // Latest plan for this issue (any status) + its versions.
  const [plan] = await db
    .select()
    .from(plans)
    .where(eq(plans.issueId, issueId))
    .orderBy(desc(plans.id))
    .limit(1);

  const versionRows = plan
    ? await db
        .select()
        .from(planVersions)
        .where(eq(planVersions.planId, plan.id))
        .orderBy(desc(planVersions.version))
    : [];

  const executionRows = await db
    .select()
    .from(executions)
    .where(eq(executions.issueId, issueId))
    .orderBy(desc(executions.id));

  // Serialize for the client component (dates → ISO strings).
  const panelPlan: PlanPanelPlan | null = plan
    ? {
        id: plan.id,
        status: plan.status,
        currentVersionId: plan.currentVersionId,
        stale: plan.basedOnHash !== issue.contentHash,
        rejectReason: plan.rejectReason,
      }
    : null;
  const panelVersions: PlanPanelVersion[] = versionRows.map((v) => ({
    id: v.id,
    version: v.version,
    authorType: v.authorType,
    createdAt: v.createdAt ? v.createdAt.toISOString() : null,
    contentMd: v.contentMd,
  }));

  const labels = Array.isArray(issue.labels) ? (issue.labels as string[]) : [];
  const githubUrl = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/"
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
        >
          ← Dashboard
        </Link>
      </div>

      {/* Issue header */}
      <header className="rounded-xl border border-zinc-200 bg-white px-6 py-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
          <span className="font-medium text-zinc-700">
            {repo.owner}/{repo.name}
          </span>
          <span>#{issue.number ?? "—"}</span>
          {issue.state ? <StatusBadge status={issue.state} /> : null}
          <span className="ms-auto text-xs">
            updated {relativeTime(issue.githubUpdatedAt)}
          </span>
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-zinc-900">
          {issue.title ?? "(untitled)"}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {labels.map((label) => (
            <span
              key={label}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
            >
              {label}
            </span>
          ))}
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            className="ms-auto text-sm font-medium text-blue-600 hover:underline"
          >
            View on GitHub ↗
          </a>
        </div>
      </header>

      {/* Disabled-repo notice — the repo is still watched but excluded from
          automatic runs; manual planning below still works. */}
      {repo.enabled !== true ? (
        <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-6 py-4 text-sm text-zinc-600">
          <span className="font-medium text-zinc-700">Repo disabled.</span>{" "}
          {repo.owner}/{repo.name} is still watched but its issues are excluded
          from automatic runs. You can still plan this issue manually below — it
          won&apos;t change the repo&apos;s disabled state.
        </p>
      ) : null}

      {/* Issue body */}
      <section className="rounded-xl border border-zinc-200 bg-white px-6 py-5">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900">Issue</h2>
        {issue.body && issue.body.trim().length > 0 ? (
          <MarkdownView content={issue.body} />
        ) : (
          <p className="text-sm italic text-zinc-400">No description.</p>
        )}
        {issue.authorLogin ? (
          <p className="mt-4 text-xs text-zinc-400">
            opened by {issue.authorLogin}
            {issue.commentsCount ? ` · ${issue.commentsCount} comments` : ""}
          </p>
        ) : null}
      </section>

      {/* Plan panel (interactive) */}
      <PlanPanel issueId={issue.id} plan={panelPlan} versions={panelVersions} />

      {/* Execution history */}
      {executionRows.length > 0 ? (
        <section className="rounded-xl border border-zinc-200 bg-white">
          <h2 className="border-b border-zinc-100 px-6 py-3 text-sm font-semibold text-zinc-900">
            Executions
          </h2>
          <ul className="divide-y divide-zinc-100">
            {executionRows.map((execution) => (
              <li
                key={execution.id}
                className="flex flex-wrap items-center gap-3 px-6 py-3 text-sm"
              >
                <Link
                  href={`/executions/${execution.id}`}
                  className="font-medium text-zinc-900 hover:underline"
                >
                  Execution #{execution.id}
                </Link>
                <StatusBadge status={execution.status} />
                {execution.branchName ? (
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600">
                    {execution.branchName}
                  </code>
                ) : null}
                {execution.prUrl ? (
                  <a
                    href={execution.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-blue-600 hover:underline"
                  >
                    View PR ↗
                  </a>
                ) : null}
                {execution.error ? (
                  <span
                    className="max-w-xs truncate text-xs text-red-600"
                    title={execution.error}
                  >
                    {execution.error}
                  </span>
                ) : null}
                <span className="ms-auto text-xs text-zinc-500">
                  {relativeTime(execution.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
