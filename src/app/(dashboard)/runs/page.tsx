/**
 * Runs — morning sync/planning runs with expandable per-issue items.
 */
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { StatusBadge } from "@/components/status-badge";
import { runNowAction } from "@/app/actions/runs";
import { getDb } from "@/db/client";
import { issues, repos, runItems, runs } from "@/db/schema";

export const dynamic = "force-dynamic";

const RunStatsZ = z.object({
  repos_synced: z.number().optional(),
  issues_scanned: z.number().optional(),
  queued: z.number().optional(),
  sync_errors: z
    .array(z.object({ repo: z.string(), error: z.string() }))
    .optional(),
});

const AgentStatsZ = z.object({
  durationMs: z.number().optional(),
});

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(d: Date | null): string {
  return d ? `${dateFmt.format(d)} UTC` : "—";
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

type RunItemView = {
  id: number;
  runId: number;
  status: string;
  error: string | null;
  durationMs: number | undefined;
  issueNumber: number | null;
  issueTitle: string | null;
  owner: string;
  repoName: string;
};

export default async function RunsPage() {
  const db = getDb();

  const runRows = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.id))
    .limit(50);

  const runIds = runRows.map((r) => r.id);
  const itemRows: RunItemView[] =
    runIds.length === 0
      ? []
      : (
          await db
            .select({
              id: runItems.id,
              runId: runItems.runId,
              status: runItems.status,
              error: runItems.error,
              agentStats: runItems.agentStats,
              issueNumber: issues.number,
              issueTitle: issues.title,
              owner: repos.owner,
              repoName: repos.name,
            })
            .from(runItems)
            .innerJoin(issues, eq(runItems.issueId, issues.id))
            .innerJoin(repos, eq(issues.repoId, repos.id))
            .where(inArray(runItems.runId, runIds))
            .orderBy(asc(runItems.id))
        ).map((row) => {
          const stats = AgentStatsZ.safeParse(row.agentStats);
          return {
            id: row.id,
            runId: row.runId,
            status: row.status,
            error: row.error,
            durationMs: stats.success ? stats.data.durationMs : undefined,
            issueNumber: row.issueNumber,
            issueTitle: row.issueTitle,
            owner: row.owner,
            repoName: row.repoName,
          };
        });

  const itemsByRun = new Map<number, RunItemView[]>();
  for (const item of itemRows) {
    const list = itemsByRun.get(item.runId);
    if (list) list.push(item);
    else itemsByRun.set(item.runId, [item]);
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">Runs</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Morning sync and planning runs — newest first.
          </p>
        </div>
        <form action={runNowAction}>
          <button
            type="submit"
            title="Enqueue a manual run. A no-op if one is already pending."
            className="rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
          >
            Run now
          </button>
        </form>
      </header>

      {runRows.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center shadow-sm">
          <p className="text-sm text-zinc-500">
            No runs yet. Trigger one with the button above, or wait for the
            morning schedule.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {runRows.map((run) => {
            const parsedStats = RunStatsZ.safeParse(run.stats);
            const stats = parsedStats.success ? parsedStats.data : {};
            const items = itemsByRun.get(run.id) ?? [];
            const planned = items.filter((i) => i.status === "planned").length;
            const failed = items.filter((i) => i.status === "failed").length;
            const syncErrors = stats.sync_errors ?? [];

            return (
              <li key={run.id}>
                <details className="group rounded-xl border border-zinc-200 bg-white shadow-sm open:shadow">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 [&::-webkit-details-marker]:hidden">
                    <span className="text-zinc-400 transition-transform group-open:rotate-90">
                      ▸
                    </span>
                    <span className="font-mono text-xs text-zinc-400">
                      #{run.id}
                    </span>
                    <span className="text-sm font-medium text-zinc-900">
                      {formatDate(run.startedAt)}
                    </span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                      {run.trigger}
                    </span>
                    <StatusBadge status={run.status} />
                    <span className="ml-auto text-xs text-zinc-500">
                      {stats.repos_synced ?? 0} repos synced ·{" "}
                      {stats.issues_scanned ?? 0} issues scanned ·{" "}
                      {stats.queued ?? 0} queued · {planned} planned · {failed}{" "}
                      failed
                    </span>
                    <span className="text-xs text-zinc-400">
                      finished {formatDate(run.finishedAt)}
                    </span>
                  </summary>

                  <div className="border-t border-zinc-100 px-5 py-4">
                    {run.error ? (
                      <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        {run.error}
                      </p>
                    ) : null}
                    {syncErrors.length > 0 ? (
                      <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        <p className="font-medium">Sync errors</p>
                        <ul className="mt-1 list-inside list-disc">
                          {syncErrors.map((e, idx) => (
                            <li key={idx}>
                              <span className="font-mono text-xs">{e.repo}</span>
                              : {e.error}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {items.length === 0 ? (
                      <p className="text-sm text-zinc-500">
                        No issues were queued in this run.
                      </p>
                    ) : (
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                            <th className="py-2 pr-4 font-medium">Issue</th>
                            <th className="py-2 pr-4 font-medium">Status</th>
                            <th className="py-2 pr-4 font-medium">Duration</th>
                            <th className="py-2 font-medium">Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item) => (
                            <tr
                              key={item.id}
                              className="border-b border-zinc-100 align-top"
                            >
                              <td className="max-w-md py-2.5 pr-4">
                                <a
                                  href={`https://github.com/${item.owner}/${item.repoName}/issues/${item.issueNumber ?? ""}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-medium text-zinc-900 hover:underline"
                                >
                                  {item.owner}/{item.repoName}#
                                  {item.issueNumber ?? "?"}
                                </a>
                                <p className="truncate text-xs text-zinc-500">
                                  {item.issueTitle ?? ""}
                                </p>
                              </td>
                              <td className="py-2.5 pr-4">
                                <StatusBadge status={item.status} />
                              </td>
                              <td className="py-2.5 pr-4 text-zinc-600">
                                {formatDuration(item.durationMs)}
                              </td>
                              <td className="py-2.5 text-xs text-red-600">
                                {item.error ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
