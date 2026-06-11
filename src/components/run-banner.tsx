/**
 * RunBanner — latest morning-run status, shown at the top of the dashboard.
 * Purely presentational server component; the "Run now" form lives in the
 * page so this stays a dumb renderer.
 */
import Link from "next/link";

import type { RunRow } from "@/db/schema";

import { formatUtcTime, relativeTime } from "./format";
import { StatusBadge } from "./status-badge";

const BANNER_STYLES: Record<string, string> = {
  running: "border-blue-200 bg-blue-50",
  paused_rate_limit: "border-orange-200 bg-orange-50",
  completed: "border-green-200 bg-green-50",
  completed_with_errors: "border-amber-200 bg-amber-50",
  failed: "border-red-200 bg-red-50",
  cancelled: "border-zinc-200 bg-zinc-50",
};

function statsSummary(stats: unknown): string | null {
  if (!stats || typeof stats !== "object") return null;
  const s = stats as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof s.repos_synced === "number") {
    parts.push(`${s.repos_synced} repos synced`);
  }
  if (typeof s.issues_scanned === "number") {
    parts.push(`${s.issues_scanned} issues scanned`);
  }
  if (typeof s.queued === "number") {
    parts.push(`${s.queued} queued for planning`);
  }
  const syncErrors = Array.isArray(s.sync_errors) ? s.sync_errors.length : 0;
  if (syncErrors > 0) {
    parts.push(`${syncErrors} sync error${syncErrors === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function RunBanner({ run }: { run: RunRow | null }) {
  if (!run) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-500">
        No runs yet — press <span className="font-medium text-zinc-700">Run now</span> to
        sync your repos and generate the first plans.
      </div>
    );
  }

  const style = BANNER_STYLES[run.status] ?? "border-zinc-200 bg-white";
  const stats = statsSummary(run.stats);

  let message: string;
  switch (run.status) {
    case "running":
      message = "Syncing issues and generating plans…";
      break;
    case "paused_rate_limit":
      message = run.resumeAt
        ? `Claude usage limit reached — resuming at ${formatUtcTime(run.resumeAt)}`
        : "Claude usage limit reached — resuming when the limit window clears";
      break;
    case "completed":
      message = "Completed";
      break;
    case "completed_with_errors":
      message = "Completed with errors";
      break;
    case "failed":
      message = run.error ? `Failed: ${run.error}` : "Failed";
      break;
    case "cancelled":
      message = "Cancelled";
      break;
    default:
      message = run.status;
  }

  return (
    <div className={`rounded-xl border px-4 py-3 ${style}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* /runs is the list page (per-run expandable detail) — there is no
            /runs/[id] route. */}
        <Link
          href="/runs"
          className="text-sm font-semibold text-zinc-900 hover:underline"
        >
          Run #{run.id}
        </Link>
        <StatusBadge status={run.status} />
        <span className="text-sm text-zinc-700">{message}</span>
        <span className="ms-auto text-xs text-zinc-500">
          {run.trigger} · started {relativeTime(run.startedAt)}
          {run.finishedAt ? ` · finished ${relativeTime(run.finishedAt)}` : ""}
        </span>
      </div>
      {stats ? <p className="mt-1 text-xs text-zinc-600">{stats}</p> : null}
    </div>
  );
}
