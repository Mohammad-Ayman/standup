/**
 * PlanCard — one issue row in the dashboard's grouped issue list:
 * repo, #number, title, labels, plan StatusBadge, stale badge, updated time.
 * The whole left side links to the issue detail page; the PR link (executed
 * plans) is a separate anchor so we never nest <a> elements.
 */
import Link from "next/link";

import { relativeTime } from "./format";
import { StatusBadge } from "./status-badge";

export type IssueListItem = {
  issueId: number;
  repo: string;
  number: number | null;
  title: string | null;
  labels: string[];
  planStatus: string | null;
  stale: boolean;
  prUrl: string | null;
  updatedAt: Date | null;
};

const MAX_LABELS = 4;

export function PlanCard({ item }: { item: IssueListItem }) {
  const shownLabels = item.labels.slice(0, MAX_LABELS);
  const hiddenLabels = item.labels.length - shownLabels.length;

  return (
    <li className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-zinc-50">
      <Link href={`/issues/${item.issueId}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-medium text-zinc-600">{item.repo}</span>
          <span>#{item.number ?? "—"}</span>
          <span aria-hidden>·</span>
          <span>updated {relativeTime(item.updatedAt)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-900">
            {item.title ?? "(untitled)"}
          </span>
          {shownLabels.map((label) => (
            <span
              key={label}
              className="hidden shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 sm:inline-flex"
            >
              {label}
            </span>
          ))}
          {hiddenLabels > 0 ? (
            <span className="hidden shrink-0 text-xs text-zinc-400 sm:inline">
              +{hiddenLabels}
            </span>
          ) : null}
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-2">
        {item.stale ? (
          <span
            title="The issue changed on GitHub after this plan was generated"
            className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20"
          >
            stale
          </span>
        ) : null}
        {item.prUrl ? (
          <a
            href={item.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            View PR ↗
          </a>
        ) : null}
        {item.planStatus ? (
          <StatusBadge status={item.planStatus} />
        ) : (
          <span className="text-xs text-zinc-400">no plan</span>
        )}
      </div>
    </li>
  );
}
