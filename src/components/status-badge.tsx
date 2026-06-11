/**
 * StatusBadge — small colored pill for any status string in the system
 * (plan_status, run_status, run_item_status, execution_status, issue state).
 * Unknown statuses fall back to a neutral zinc badge.
 */

const STATUS_STYLES: Record<string, string> = {
  // plan_status
  draft: "bg-amber-50 text-amber-700 ring-amber-600/20",
  approved: "bg-green-50 text-green-700 ring-green-600/20",
  rejected: "bg-rose-50 text-rose-700 ring-rose-600/20",
  superseded: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  executing: "bg-blue-50 text-blue-700 ring-blue-600/20",
  executed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  failed: "bg-red-50 text-red-700 ring-red-600/20",
  // run_status
  running: "bg-blue-50 text-blue-700 ring-blue-600/20",
  completed: "bg-green-50 text-green-700 ring-green-600/20",
  completed_with_errors: "bg-amber-50 text-amber-700 ring-amber-600/20",
  paused_rate_limit: "bg-orange-50 text-orange-700 ring-orange-600/20",
  cancelled: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  // run_item_status
  queued: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  planning: "bg-blue-50 text-blue-700 ring-blue-600/20",
  planned: "bg-green-50 text-green-700 ring-green-600/20",
  skipped: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  deferred: "bg-orange-50 text-orange-700 ring-orange-600/20",
  // execution_status
  cloning: "bg-blue-50 text-blue-700 ring-blue-600/20",
  pushing: "bg-blue-50 text-blue-700 ring-blue-600/20",
  pr_opened: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  // issue state
  open: "bg-green-50 text-green-700 ring-green-600/20",
  closed: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

const FALLBACK_STYLE = "bg-zinc-100 text-zinc-600 ring-zinc-500/20";

/** Statuses that imply work is actively happening — get a pulsing dot. */
const ACTIVE_STATUSES = new Set([
  "running",
  "executing",
  "planning",
  "cloning",
  "pushing",
]);

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? FALLBACK_STYLE;
  const active = ACTIVE_STATUSES.has(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}
    >
      {active ? (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-current"
        />
      ) : null}
      {status.replaceAll("_", " ")}
    </span>
  );
}

// Exported both ways: the contract names the named export; sibling pages
// written in parallel import it as a default.
export { StatusBadge };
export default StatusBadge;
