/**
 * Execution detail — header (issue, branch, status, PR / error) + live log.
 *
 * The header is server-rendered; the log tail is a client component that
 * polls /api/executions/[id]/logs and refreshes the route when the execution
 * reaches a terminal state (so this header updates too).
 */
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/db/client";
import { executions, issues, repos } from "@/db/schema";

import LogTail from "./log-tail";

export const dynamic = "force-dynamic";

const IdZ = z.coerce.number().int().positive();

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(d: Date | null): string {
  return d ? `${dateFmt.format(d)} UTC` : "—";
}

export default async function ExecutionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const parsedId = IdZ.safeParse(rawId);
  if (!parsedId.success) {
    notFound();
  }
  const executionId = parsedId.data;

  const [row] = await getDb()
    .select({
      execution: executions,
      issueNumber: issues.number,
      issueTitle: issues.title,
      owner: repos.owner,
      repoName: repos.name,
    })
    .from(executions)
    .innerJoin(issues, eq(executions.issueId, issues.id))
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .where(eq(executions.id, executionId))
    .limit(1);

  if (!row) {
    notFound();
  }

  const { execution, issueNumber, issueTitle, owner, repoName } = row;
  const issueUrl = `https://github.com/${owner}/${repoName}/issues/${issueNumber ?? ""}`;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
      <header className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900">
            Execution <span className="font-mono text-zinc-400">#{execution.id}</span>
          </h1>
          <StatusBadge status={execution.status} />
          {execution.prUrl ? (
            <a
              href={execution.prUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
            >
              View pull request
              {execution.prNumber ? ` #${execution.prNumber}` : ""}
            </a>
          ) : null}
        </div>

        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">
              Issue
            </dt>
            <dd className="mt-0.5">
              <a
                href={issueUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-zinc-900 hover:underline"
              >
                {owner}/{repoName}#{issueNumber ?? "?"}
              </a>
              <span className="ml-2 text-zinc-500">{issueTitle ?? ""}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">
              Branch
            </dt>
            <dd className="mt-0.5">
              {execution.branchName ? (
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">
                  {execution.branchName}
                </code>
              ) : (
                <span className="text-zinc-400">not created yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">
              Started
            </dt>
            <dd className="mt-0.5 text-zinc-700">
              {formatDate(execution.startedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">
              Finished
            </dt>
            <dd className="mt-0.5 text-zinc-700">
              {formatDate(execution.finishedAt)}
            </dd>
          </div>
        </dl>

        {execution.status === "failed" && execution.error ? (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
              Error
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-red-700">
              {execution.error}
            </p>
          </div>
        ) : null}
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <LogTail executionId={execution.id} initialStatus={execution.status} />
      </section>
    </div>
  );
}
