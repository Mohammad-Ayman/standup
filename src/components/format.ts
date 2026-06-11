/**
 * Deterministic date formatting helpers for the dashboard UI.
 *
 * All formatting is done in UTC with fixed month names so server- and
 * client-rendered output is byte-identical (no hydration mismatches from
 * differing timezones/locales).
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function toDate(input: string | Date | null | undefined): Date | null {
  if (input === null || input === undefined) return null;
  const d = typeof input === "string" ? new Date(input) : input;
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "Jun 11, 07:05 UTC" (or "Jun 11" with withTime=false). */
export function formatUtc(
  input: string | Date | null | undefined,
  withTime = true,
): string {
  const d = toDate(input);
  if (!d) return "—";
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (!withTime) return date;
  return `${date}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "07:05 UTC" — used for the run banner's "resuming at HH:MM". */
export function formatUtcTime(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "just now" / "12m ago" / "3h ago" / "5d ago" / "Jun 11" (older). */
export function relativeTime(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return formatUtc(d);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatUtc(d, false);
}
