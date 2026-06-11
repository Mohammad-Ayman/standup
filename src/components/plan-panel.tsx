"use client";

/**
 * PlanPanel — the interactive plan review surface on the issue detail page:
 * current plan rendered as markdown, edit mode with live side-by-side
 * preview, approve / reject (optional reason) / execute / plan-now buttons,
 * and a collapsible version history (click a version to view its content).
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  approveAction,
  executeAction,
  planNowAction,
  rejectAction,
  saveEditAction,
} from "@/app/actions/plans";

import { formatUtc } from "./format";
import { MarkdownView } from "./markdown-view";
import { StatusBadge } from "./status-badge";

export type PlanPanelPlan = {
  id: number;
  status: string;
  currentVersionId: number | null;
  stale: boolean;
  rejectReason: string | null;
};

export type PlanPanelVersion = {
  id: number;
  version: number;
  authorType: "agent" | "user";
  createdAt: string | null; // ISO
  contentMd: string;
};

const BTN_PRIMARY =
  "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_GREEN =
  "rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_BLUE =
  "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_GHOST =
  "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_DANGER =
  "rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

export function PlanPanel({
  issueId,
  plan,
  versions,
}: {
  issueId: number;
  plan: PlanPanelPlan | null;
  versions: PlanPanelVersion[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);

  const currentVersion = plan
    ? (versions.find((v) => v.id === plan.currentVersionId) ?? versions[0] ?? null)
    : null;
  const shownVersion =
    (selectedVersionId !== null
      ? versions.find((v) => v.id === selectedVersionId)
      : undefined) ?? currentVersion;
  const viewingOldVersion =
    shownVersion !== null && currentVersion !== null && shownVersion.id !== currentVersion.id;

  function run(fn: () => Promise<void>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Action failed — check the server logs.",
        );
      }
    });
  }

  const handlePlanNow = () =>
    run(async () => {
      await planNowAction(issueId);
      setNotice("Planning queued — a fresh plan will appear here shortly.");
    });

  const handleApprove = () => {
    if (!plan) return;
    run(() => approveAction(plan.id));
  };

  const handleReject = () => {
    if (!plan) return;
    run(async () => {
      await rejectAction(plan.id, rejectReason.trim() || undefined);
      setRejectOpen(false);
      setRejectReason("");
    });
  };

  const handleExecute = () => {
    if (!plan) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const executionId = await executeAction(plan.id);
        router.push(`/executions/${executionId}`);
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Action failed — check the server logs.",
        );
      }
    });
  };

  const handleStartEdit = () => {
    setDraft(currentVersion?.contentMd ?? "");
    setSelectedVersionId(null);
    setRejectOpen(false);
    setEditing(true);
  };

  const handleSave = () => {
    if (!plan) return;
    run(async () => {
      await saveEditAction(plan.id, draft);
      setEditing(false);
      setSelectedVersionId(null);
    });
  };

  // ------------------------------------------------------------------
  // No plan yet
  // ------------------------------------------------------------------
  if (!plan || !shownVersion) {
    return (
      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Plan</h2>
        </div>
        <p className="mt-3 text-sm text-zinc-500">
          No plan has been generated for this issue yet.
        </p>
        {notice ? <p className="mt-2 text-sm text-green-700">{notice}</p> : null}
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button
          type="button"
          onClick={handlePlanNow}
          disabled={isPending}
          className={`mt-4 ${BTN_PRIMARY}`}
        >
          {isPending ? "Queueing…" : "Plan now"}
        </button>
      </section>
    );
  }

  // ------------------------------------------------------------------
  // Plan exists
  // ------------------------------------------------------------------
  const canEdit = (plan.status === "draft" || plan.status === "approved") && !editing;
  const canApprove = plan.status === "draft" && !editing;
  const canReject =
    (plan.status === "draft" || plan.status === "approved") && !editing;
  const canExecute = plan.status === "approved" && !editing;
  const canReplan =
    !editing &&
    (["rejected", "superseded", "executed", "failed"].includes(plan.status) ||
      plan.stale);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      {/* Panel header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-6 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">Plan</h2>
        <StatusBadge status={plan.status} />
        {plan.stale ? (
          <span
            title="The issue changed on GitHub after this plan was generated"
            className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20"
          >
            stale — issue changed since this plan was generated
          </span>
        ) : null}
        <span className="ms-auto text-xs text-zinc-500">
          v{shownVersion.version} · {shownVersion.authorType} ·{" "}
          {formatUtc(shownVersion.createdAt)}
        </span>
      </div>

      <div className="px-6 py-4">
        {plan.status === "rejected" && plan.rejectReason ? (
          <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            Rejected: {plan.rejectReason}
          </p>
        ) : null}

        {notice ? (
          <p className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}

        {viewingOldVersion ? (
          <div className="mb-4 flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            <span>
              Viewing v{shownVersion.version} ({shownVersion.authorType}) — not
              the current version.
            </span>
            <button
              type="button"
              onClick={() => setSelectedVersionId(null)}
              className="font-medium underline underline-offset-2"
            >
              Back to current
            </button>
          </div>
        ) : null}

        {/* Content: edit mode (textarea + live preview) or rendered markdown */}
        {editing ? (
          <div>
            {plan.status === "approved" ? (
              <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Heads up: saving an edit to an approved plan resets it to draft
                — it will need re-approval before it can be executed.
              </p>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Markdown
                </p>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="h-96 w-full resize-y rounded-lg border border-zinc-300 p-3 font-mono text-sm text-zinc-800 focus:border-zinc-500 focus:outline-none"
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Preview
                </p>
                <div className="h-96 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <MarkdownView content={draft} />
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={isPending || draft.trim().length === 0}
                className={BTN_PRIMARY}
              >
                {isPending ? "Saving…" : "Save as new version"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={isPending}
                className={BTN_GHOST}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <MarkdownView content={shownVersion.contentMd} />
        )}
      </div>

      {/* Action bar */}
      {!editing ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-6 py-4">
          {canApprove ? (
            <button
              type="button"
              onClick={handleApprove}
              disabled={isPending}
              className={BTN_GREEN}
            >
              Approve
            </button>
          ) : null}
          {canExecute ? (
            <button
              type="button"
              onClick={handleExecute}
              disabled={isPending}
              className={BTN_BLUE}
            >
              {isPending ? "Queueing…" : "Execute"}
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={handleStartEdit}
              disabled={isPending}
              className={BTN_GHOST}
            >
              Edit
            </button>
          ) : null}
          {canReject ? (
            <button
              type="button"
              onClick={() => setRejectOpen((open) => !open)}
              disabled={isPending}
              className={BTN_DANGER}
            >
              Reject
            </button>
          ) : null}
          {canReplan ? (
            <button
              type="button"
              onClick={handlePlanNow}
              disabled={isPending}
              className={BTN_GHOST}
            >
              {isPending ? "Queueing…" : "Replan"}
            </button>
          ) : null}
          {plan.status === "executing" ? (
            <span className="text-sm text-zinc-500">
              Execution in progress — see the executions list below.
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Reject reason input */}
      {rejectOpen && !editing ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-zinc-50 px-6 py-4">
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason (optional)"
            className="min-w-64 flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleReject}
            disabled={isPending}
            className={BTN_DANGER}
          >
            {isPending ? "Rejecting…" : "Confirm reject"}
          </button>
          <button
            type="button"
            onClick={() => {
              setRejectOpen(false);
              setRejectReason("");
            }}
            disabled={isPending}
            className={BTN_GHOST}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {/* Version history */}
      {versions.length > 0 ? (
        <details className="border-t border-zinc-100 px-6 py-4">
          <summary className="cursor-pointer select-none text-sm font-medium text-zinc-700">
            Version history ({versions.length})
          </summary>
          <ul className="mt-3 space-y-1">
            {versions.map((v) => {
              const isCurrent = currentVersion !== null && v.id === currentVersion.id;
              const isShown = shownVersion !== null && v.id === shownVersion.id;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedVersionId(isCurrent ? null : v.id)
                    }
                    className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-zinc-50 ${
                      isShown ? "bg-zinc-100" : ""
                    }`}
                  >
                    <span className="font-medium text-zinc-900">
                      v{v.version}
                    </span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                      {v.authorType}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {formatUtc(v.createdAt)}
                    </span>
                    {isCurrent ? (
                      <span className="ms-auto text-xs font-medium text-green-700">
                        current
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
