/**
 * Settings — secrets, watched repos, schedule.
 *
 * Server component: all data fetched here, all mutations via server actions
 * in src/app/actions/settings.ts. Action results come back as short
 * query-string notices (never secret plaintext).
 */
import { asc } from "drizzle-orm";

import {
  addRepoAction,
  removeRepoAction,
  saveScheduleAction,
  saveSecretAction,
  toggleRepoAction,
  validatePatAction,
} from "@/app/actions/settings";
import { getDb } from "@/db/client";
import { repos } from "@/db/schema";
import {
  getMaxIssuesPerRun,
  getSchedule,
  getSecretStatus,
  getSettingValue,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500";
const primaryBtn =
  "rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700";
const secondaryBtn =
  "rounded-md border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50";
const labelCls = "block text-sm font-medium text-zinc-700";
const helpCls = "text-xs text-zinc-500";

const SAVED_MESSAGES: Record<string, string> = {
  github_pat: "GitHub PAT saved.",
  claude_oauth_token: "Claude OAuth token saved.",
  schedule: "Settings saved.",
};

function param(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function secretStatusText(status: { set: boolean; last4?: string }): string {
  return status.set ? `Set (****${status.last4 ?? ""})` : "Not set";
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(d: Date | null): string {
  return d ? `${dateFmt.format(d)} UTC` : "—";
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const saved = param(params, "saved");
  const savedMessage = saved ? SAVED_MESSAGES[saved] : undefined;
  const globalError = param(params, "error");
  const patOk = param(params, "pat_ok");
  const patError = param(params, "pat_error");
  const repoNotice = param(params, "repo_notice");
  const repoError = param(params, "repo_error");
  const scheduleError = param(params, "schedule_error");

  const [
    patStatus,
    claudeStatus,
    schedule,
    maxIssues,
    plannerModel,
    executorModel,
    replanRejected,
    repoRows,
  ] = await Promise.all([
    getSecretStatus("github_pat"),
    getSecretStatus("claude_oauth_token"),
    getSchedule(),
    getMaxIssuesPerRun(),
    getSettingValue<string>("planner_model", "claude-sonnet-4-6"),
    getSettingValue<string>("executor_model", "claude-opus-4-8"),
    getSettingValue<boolean>("replan_rejected", true),
    getDb().select().from(repos).orderBy(asc(repos.owner), asc(repos.name)),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Secrets, watched repositories, and the morning schedule.
        </p>
      </header>

      {savedMessage ? (
        <p
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {savedMessage}
        </p>
      ) : null}
      {globalError ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {globalError}
        </p>
      ) : null}

      {/* ----------------------------------------------------------------- */}
      {/* Secrets                                                            */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Secrets</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Stored encrypted (AES-256-GCM). Values are never shown again after
          saving.
        </p>

        {/* GitHub PAT */}
        <form action={saveSecretAction} className="mt-6 space-y-3">
          <input type="hidden" name="key" value="github_pat" />
          <div className="flex items-center justify-between">
            <label htmlFor="github_pat" className={labelCls}>
              GitHub personal access token
            </label>
            <span
              className={`text-xs font-medium ${patStatus.set ? "text-emerald-600" : "text-zinc-400"}`}
            >
              {secretStatusText(patStatus)}
            </span>
          </div>
          <input
            id="github_pat"
            name="value"
            type="password"
            autoComplete="off"
            placeholder="github_pat_…"
            className={inputCls}
          />
          <p className={helpCls}>
            Create a fine-grained PAT (GitHub → Settings → Developer settings →
            Fine-grained tokens) scoped to the repos you want watched, with
            repository permissions: Contents (Read and write), Issues
            (Read-only), Pull requests (Read and write), Metadata (Read-only).
          </p>
          <div className="flex items-center gap-2">
            <button type="submit" className={primaryBtn}>
              Save
            </button>
            <button
              type="submit"
              formAction={validatePatAction}
              className={secondaryBtn}
            >
              Validate
            </button>
          </div>
          {patOk ? (
            <p
              role="status"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
            >
              Token is valid — authenticated as{" "}
              <span className="font-semibold">{patOk}</span>.
            </p>
          ) : null}
          {patError ? (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {patError}
            </p>
          ) : null}
        </form>

        <hr className="my-6 border-zinc-100" />

        {/* Claude OAuth token */}
        <form action={saveSecretAction} className="space-y-3">
          <input type="hidden" name="key" value="claude_oauth_token" />
          <div className="flex items-center justify-between">
            <label htmlFor="claude_oauth_token" className={labelCls}>
              Claude OAuth token
            </label>
            <span
              className={`text-xs font-medium ${claudeStatus.set ? "text-emerald-600" : "text-zinc-400"}`}
            >
              {secretStatusText(claudeStatus)}
            </span>
          </div>
          <input
            id="claude_oauth_token"
            name="value"
            type="password"
            autoComplete="off"
            placeholder="sk-ant-oat…"
            className={inputCls}
          />
          <p className={helpCls}>
            Run{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700">
              claude setup-token
            </code>{" "}
            locally to mint a long-lived OAuth token (requires a Claude Pro or
            Max subscription), then paste it here.
          </p>
          <div>
            <button type="submit" className={primaryBtn}>
              Save
            </button>
          </div>
        </form>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Watched repos                                                      */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">
          Watched repositories
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Open issues in these repositories are synced and planned every
          morning.
        </p>

        <form action={addRepoAction} className="mt-4 flex items-start gap-2">
          <div className="flex-1">
            <label htmlFor="repo" className="sr-only">
              Repository (owner/name)
            </label>
            <input
              id="repo"
              name="repo"
              type="text"
              placeholder="owner/name"
              autoComplete="off"
              className={inputCls}
            />
          </div>
          <button type="submit" className={primaryBtn}>
            Add
          </button>
        </form>
        {repoNotice ? (
          <p
            role="status"
            className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          >
            {repoNotice}
          </p>
        ) : null}
        {repoError ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {repoError}
          </p>
        ) : null}

        {repoRows.length === 0 ? (
          <p className="mt-6 text-sm text-zinc-500">
            No repositories watched yet.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Repository</th>
                  <th className="py-2 pr-4 font-medium">Default branch</th>
                  <th className="py-2 pr-4 font-medium">Enabled</th>
                  <th className="py-2 pr-4 font-medium">Last synced</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {repoRows.map((repo) => (
                  <tr key={repo.id} className="border-b border-zinc-100">
                    <td className="py-2.5 pr-4">
                      <a
                        href={`https://github.com/${repo.owner}/${repo.name}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {repo.owner}/{repo.name}
                      </a>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-zinc-600">
                      {repo.defaultBranch}
                    </td>
                    <td className="py-2.5 pr-4">
                      <form action={toggleRepoAction}>
                        <input type="hidden" name="repoId" value={repo.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={repo.enabled ? "false" : "true"}
                        />
                        <button
                          type="submit"
                          title={
                            repo.enabled
                              ? "Click to disable syncing"
                              : "Click to enable syncing"
                          }
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                            repo.enabled
                              ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                          }`}
                        >
                          {repo.enabled ? "Enabled" : "Disabled"}
                        </button>
                      </form>
                    </td>
                    <td className="py-2.5 pr-4 text-zinc-600">
                      {formatDate(repo.lastSyncedAt)}
                    </td>
                    <td className="py-2.5 text-right">
                      <form action={removeRepoAction}>
                        <input type="hidden" name="repoId" value={repo.id} />
                        <button
                          type="submit"
                          className="text-xs font-medium text-red-600 hover:text-red-700 hover:underline"
                        >
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Schedule                                                           */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Schedule</h2>
        <p className="mt-1 text-sm text-zinc-500">
          When the morning run happens and how plans are generated.
        </p>

        {scheduleError ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {scheduleError}
          </p>
        ) : null}

        <form
          action={saveScheduleAction}
          className="mt-4 grid gap-4 sm:grid-cols-2"
        >
          <div className="space-y-1.5">
            <label htmlFor="cron" className={labelCls}>
              Cron expression
            </label>
            <input
              id="cron"
              name="cron"
              type="text"
              defaultValue={schedule.cron}
              className={`${inputCls} font-mono`}
            />
            <p className={helpCls}>
              5 fields: minute hour day month weekday. Default: 0 7 * * *
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="tz" className={labelCls}>
              Timezone
            </label>
            <input
              id="tz"
              name="tz"
              type="text"
              defaultValue={schedule.tz}
              className={inputCls}
            />
            <p className={helpCls}>IANA name, e.g. Europe/Berlin. Default: UTC</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="maxIssues" className={labelCls}>
              Max issues per run
            </label>
            <input
              id="maxIssues"
              name="maxIssues"
              type="number"
              min={1}
              max={100}
              defaultValue={maxIssues}
              className={inputCls}
            />
            <p className={helpCls}>Default: 10</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="plannerModel" className={labelCls}>
              Planner model
            </label>
            <input
              id="plannerModel"
              name="plannerModel"
              type="text"
              defaultValue={plannerModel}
              className={`${inputCls} font-mono`}
            />
            <p className={helpCls}>Default: claude-sonnet-4-6</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="executorModel" className={labelCls}>
              Executor model
            </label>
            <input
              id="executorModel"
              name="executorModel"
              type="text"
              defaultValue={executorModel}
              className={`${inputCls} font-mono`}
            />
            <p className={helpCls}>Default: claude-opus-4-8</p>
          </div>
          <div className="flex items-center gap-2 self-end pb-1">
            <input
              id="replanRejected"
              name="replanRejected"
              type="checkbox"
              defaultChecked={replanRejected}
              className="h-4 w-4 rounded border-zinc-300 accent-zinc-900"
            />
            <label htmlFor="replanRejected" className="text-sm text-zinc-700">
              Re-plan rejected issues when their content changes
            </label>
          </div>
          <div className="flex items-center justify-between gap-4 sm:col-span-2">
            <p className={helpCls}>
              Schedule changes take effect within 10 minutes — the worker
              re-applies the cron schedule periodically.
            </p>
            <button type="submit" className={primaryBtn}>
              Save settings
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
