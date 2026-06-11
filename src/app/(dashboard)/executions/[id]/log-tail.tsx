"use client";

/**
 * Live execution log tail.
 *
 * Polls GET /api/executions/[id]/logs?after=<lastId> every 2 seconds while
 * the execution is in a non-terminal state, appending new lines. When a full
 * batch (500 lines) comes back it polls again immediately to drain the
 * backlog. On reaching a terminal state it stops polling and refreshes the
 * route so the server-rendered header (status badge, PR link, error block)
 * updates as well.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type LogLine = {
  id: number;
  ts: string | null;
  stream: "agent" | "git" | "system";
  line: string;
};

type LogsResponse = {
  lines: LogLine[];
  status: string;
};

const TERMINAL_STATUSES = new Set(["pr_opened", "failed", "cancelled"]);
const BATCH_LIMIT = 500;
const POLL_MS = 2000;

const STREAM_CLASSES: Record<LogLine["stream"], string> = {
  system: "text-zinc-500",
  git: "text-amber-400",
  agent: "text-zinc-100",
};

function formatTs(ts: string | null): string {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? "--:--:--"
    : d.toLocaleTimeString("en-GB", { hour12: false });
}

export default function LogTail({
  executionId,
  initialStatus,
}: {
  executionId: number;
  initialStatus: string;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [pinned, setPinned] = useState(true);
  const [done, setDone] = useState(TERMINAL_STATUSES.has(initialStatus));

  const lastIdRef = useRef(0);
  const pinnedRef = useRef(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  const setPin = (value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
    if (value && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  // Poll loop. Even when the execution is already terminal we fetch until the
  // existing log backlog is drained, then stop.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let batch: LogLine[] = [];
      let nextStatus: string | undefined;
      try {
        const res = await fetch(
          `/api/executions/${executionId}/logs?after=${lastIdRef.current}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          throw new Error(`logs request failed (${res.status})`);
        }
        const data = (await res.json()) as LogsResponse;
        batch = data.lines;
        nextStatus = data.status;
      } catch {
        // Transient fetch error — retry on the next interval.
        if (!cancelled) {
          timer = setTimeout(tick, POLL_MS);
        }
        return;
      }

      if (cancelled) return;

      if (batch.length > 0) {
        lastIdRef.current = batch[batch.length - 1].id;
        setLines((prev) => [...prev, ...batch]);
      }
      if (nextStatus) {
        setStatus(nextStatus);
      }

      const terminal = nextStatus !== undefined && TERMINAL_STATUSES.has(nextStatus);
      if (terminal && batch.length < BATCH_LIMIT) {
        // Terminal and drained — stop polling, refresh the server header.
        setDone(true);
        router.refresh();
        return;
      }
      // Full batch -> drain immediately; otherwise wait the poll interval.
      timer = setTimeout(tick, batch.length === BATCH_LIMIT ? 0 : POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [executionId, router]);

  // Auto-scroll on new lines while pinned.
  useEffect(() => {
    if (pinnedRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && pinnedRef.current) {
      pinnedRef.current = false;
      setPinned(false);
    } else if (atBottom && !pinnedRef.current) {
      pinnedRef.current = true;
      setPinned(true);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-900">Log</h2>
          {done ? (
            <span className="text-xs text-zinc-400">finished — {status}</span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              live — {status}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setPin(!pinned)}
          aria-pressed={pinned}
          className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            pinned
              ? "border-zinc-900 bg-zinc-900 text-white"
              : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
          }`}
        >
          {pinned ? "Pinned to bottom" : "Pin to bottom"}
        </button>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-[28rem] overflow-y-auto rounded-b-xl bg-zinc-950 p-4 font-mono text-xs leading-5"
      >
        {lines.length === 0 ? (
          <p className="text-zinc-500">
            {done ? "No log output." : "Waiting for log output…"}
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="flex gap-3 whitespace-pre-wrap break-all">
              <span className="shrink-0 select-none text-zinc-600">
                {formatTs(line.ts)}
              </span>
              <span className={STREAM_CLASSES[line.stream] ?? STREAM_CLASSES.agent}>
                {line.line}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
