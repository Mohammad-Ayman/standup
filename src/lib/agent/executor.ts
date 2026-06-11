/**
 * Executor — turns an approved plan into a pull request.
 *
 * Flow: idempotency check (existing open PR) -> ephemeral shallow clone with
 * token URL (immediately reset to tokenless) -> branch -> run the Claude agent
 * with claude_code preset + restricted built-in tools inside the workspace ->
 * post-agent git policy checks -> worker (not the agent) pushes with the token
 * -> open PR -> mark plan executed.
 *
 * The PAT is injected exactly twice, both in command-array (never shell) form:
 * the initial clone URL and the push URL. Both are scrubbed from every log
 * line. The agent subprocess never receives the PAT (runAgent builds a minimal
 * env without it) and its clone's origin remote is tokenless.
 *
 * On any throw the execution row is marked 'failed' here; resetting the plan
 * back to 'approved' is the worker handler's job (Group B).
 *
 * Framework-agnostic: no next/react imports (worker calls this).
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { executionLogs, executions, issues, plans, planVersions, repos } from "../../db/schema";
import { getOctokit } from "../github";
import { getSecret, getSettingValue } from "../settings";
import { buildBranchName, buildPrTitle, ExecutionError, scrubSecret } from "./executor-helpers";
import { EXECUTOR_SYSTEM_APPEND, executorTaskPrompt } from "./prompts";
import { runAgent } from "./runAgent";

// Pure helpers live in ./executor-helpers (dependency-free, unit-tested);
// re-exported here so consumers can import them from the executor module.
export { buildBranchName, buildPrTitle, ExecutionError, scrubSecret, slugify } from "./executor-helpers";

const execFileAsync = promisify(execFile);

const EXECUTOR_MAX_TURNS = 300;
const EXECUTOR_TIMEOUT_MS = 45 * 60 * 1000;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOG_LINE = 4000;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type LogStream = "agent" | "git" | "system";

function makeLogger(executionId: number, secret: string) {
  const db = getDb();
  return async function log(stream: LogStream, line: string): Promise<void> {
    const safe = scrubSecret(line, secret).slice(0, MAX_LOG_LINE);
    try {
      await db.insert(executionLogs).values({ executionId, stream, line: safe });
    } catch (e) {
      // Logging must never take down an execution.
      console.error("[executor] failed to write execution log:", e instanceof Error ? e.message : e);
    }
  };
}

async function setStatus(
  executionId: number,
  patch: Partial<typeof executions.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db.update(executions).set(patch).where(eq(executions.id, executionId));
}

/**
 * Run git with args in array form (never through a shell — the token can never
 * be shell-interpolated). Throws ExecutionError('git_failed') with a scrubbed
 * message on non-zero exit.
 */
async function git(
  args: string[],
  opts: { cwd?: string; secret: string; log: (stream: LogStream, line: string) => Promise<void> },
): Promise<string> {
  const display = scrubSecret(`git ${args.join(" ")}`, opts.secret);
  await opts.log("git", `$ ${display}`);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const combined = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");
    if (combined) await opts.log("git", combined);
    return stdout.trim();
  } catch (e) {
    const raw =
      e instanceof Error
        ? `${e.message}\n${(e as { stderr?: string }).stderr ?? ""}`.trim()
        : String(e);
    const safe = scrubSecret(raw, opts.secret);
    await opts.log("git", `git failed: ${safe}`);
    throw new ExecutionError("git_failed", `${display} -> ${safe.slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function executeApprovedPlan(
  executionId: number,
): Promise<{ prUrl: string; branch: string }> {
  const db = getDb();

  const [execution] = await db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
  if (!execution) throw new ExecutionError("not_found", `execution ${executionId} not found`);

  const [version] = await db
    .select()
    .from(planVersions)
    .where(eq(planVersions.id, execution.planVersionId))
    .limit(1);
  if (!version) throw new ExecutionError("not_found", `plan version ${execution.planVersionId} not found`);

  const [issue] = await db.select().from(issues).where(eq(issues.id, execution.issueId)).limit(1);
  if (!issue) throw new ExecutionError("not_found", `issue ${execution.issueId} not found`);
  if (issue.number == null) {
    throw new ExecutionError("invalid_state", `issue ${execution.issueId} has no GitHub number`);
  }

  const [repo] = await db.select().from(repos).where(eq(repos.id, issue.repoId)).limit(1);
  if (!repo) throw new ExecutionError("not_found", `repo ${issue.repoId} not found`);

  const pat = await getSecret("github_pat");
  if (!pat) throw new Error("github_pat not configured");

  const octokit = await getOctokit();
  const log = makeLogger(executionId, pat);

  const issueNumber = issue.number;
  const issueTitle = issue.title ?? `issue ${issueNumber}`;
  const planMd = version.contentMd;
  const branch = buildBranchName(issueNumber, issueTitle);
  const tokenUrl = `https://x-access-token:${pat}@github.com/${repo.owner}/${repo.name}.git`;
  const cleanUrl = `https://github.com/${repo.owner}/${repo.name}.git`;

  await setStatus(executionId, { branchName: branch, startedAt: new Date() });
  await log("system", `execution ${executionId}: ${repo.owner}/${repo.name}#${issueNumber} -> ${branch}`);

  // -------------------------------------------------------------------------
  // 1. Idempotency: an open PR from this branch means a previous attempt
  //    already published — finish without re-running anything.
  // -------------------------------------------------------------------------
  const existing = await octokit.rest.pulls.list({
    owner: repo.owner,
    repo: repo.name,
    head: `${repo.owner}:${branch}`,
    state: "open",
    per_page: 1,
  });
  if (existing.data.length > 0) {
    const pr = existing.data[0];
    await log("system", `open PR already exists for ${branch}: ${pr.html_url} — skipping execution`);
    await setStatus(executionId, {
      status: "pr_opened",
      prUrl: pr.html_url,
      prNumber: pr.number,
      finishedAt: new Date(),
    });
    await db
      .update(plans)
      .set({ status: "executed", updatedAt: new Date() })
      .where(eq(plans.id, execution.planId));
    return { prUrl: pr.html_url, branch };
  }

  let ws: string | undefined;
  try {
    // -----------------------------------------------------------------------
    // 2. Clone into an ephemeral workspace; strip the token from the remote
    //    immediately so nothing the agent does can see or use it.
    // -----------------------------------------------------------------------
    await setStatus(executionId, { status: "cloning" });
    ws = await mkdtemp(path.join(os.tmpdir(), "standup-exec-"));
    await log("system", `workspace: ${ws}`);

    await git(["clone", "--depth", "50", tokenUrl, ws], { secret: pat, log });
    await git(["remote", "set-url", "origin", cleanUrl], { cwd: ws, secret: pat, log });
    await git(["checkout", "-b", branch], { cwd: ws, secret: pat, log });
    await git(["config", "user.name", "standup-bot"], { cwd: ws, secret: pat, log });
    await git(["config", "user.email", "standup-bot@users.noreply.github.com"], {
      cwd: ws,
      secret: pat,
      log,
    });

    // -----------------------------------------------------------------------
    // 3. Run the agent inside the workspace.
    // -----------------------------------------------------------------------
    await setStatus(executionId, { status: "running" });
    const model = await getSettingValue<string>("executor_model", "claude-opus-4-8");
    await log("system", `starting agent (model=${model}, maxTurns=${EXECUTOR_MAX_TURNS})`);

    const agentResult = await runAgent({
      prompt: executorTaskPrompt(planMd, { number: issueNumber, title: issueTitle }, branch),
      // Real SDK shape: claude_code preset system prompt with an append block.
      systemPrompt: { type: "preset", preset: "claude_code", append: EXECUTOR_SYSTEM_APPEND },
      cwd: ws,
      model,
      maxTurns: EXECUTOR_MAX_TURNS,
      timeoutMs: EXECUTOR_TIMEOUT_MS,
      // Restrict the BASE built-in tool set (SDK Options.tools).
      builtinTools: ["Read", "Glob", "Grep", "Edit", "Write", "TodoWrite", "Bash"],
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "TodoWrite", "Bash"],
      // Hard blocks (win over everything). Both `Bash(prefix:*)` (documented
      // permission-rule prefix syntax) and `Bash(prefix*)` forms are listed
      // for safety across rule parsers.
      disallowedTools: [
        "WebFetch",
        "WebSearch",
        "Task",
        "Bash(git push:*)",
        "Bash(git push*)",
        "Bash(git remote:*)",
        "Bash(git remote*)",
        "Bash(gh :*)",
        "Bash(gh *)",
        "Bash(curl:*)",
        "Bash(curl*)",
        "Bash(wget:*)",
        "Bash(wget*)",
      ],
      // Headless: no human to answer prompts. The PAT is absent from the env
      // and the remote is tokenless, so push/exfil paths are dead even before
      // the disallowed rules apply.
      permissionMode: "bypassPermissions",
      onEvent: async (e) => {
        await log("agent", `[${e.kind}] ${e.summary}`);
      },
    });
    await log(
      "system",
      `agent finished: turns=${agentResult.stats.numTurns} duration=${agentResult.stats.durationMs}ms`,
    );

    // -----------------------------------------------------------------------
    // 4. Post-agent git policy (worker-side, agent output is untrusted).
    // -----------------------------------------------------------------------
    const dirty = await git(["status", "--porcelain"], { cwd: ws, secret: pat, log });
    if (dirty) {
      await log("system", "uncommitted changes left by agent — committing them");
      await git(["add", "-A"], { cwd: ws, secret: pat, log });
      await git(["commit", "-m", `chore: remaining changes (refs #${issueNumber})`], {
        cwd: ws,
        secret: pat,
        log,
      });
    }

    const commitCount = await git(
      ["rev-list", "--count", `origin/${repo.defaultBranch}..HEAD`],
      { cwd: ws, secret: pat, log },
    );
    if (parseInt(commitCount, 10) === 0) {
      throw new ExecutionError("no_changes", "agent produced no commits");
    }

    // core.quotePath=false: with git's default quoting, non-ASCII paths come
    // back C-quoted in double quotes (e.g. "\".github/workflows/\\303\\251.yml\""),
    // which would evade the startsWith prefix check below.
    const changedFiles = await git(
      ["-c", "core.quotePath=false", "diff", "--name-only", `origin/${repo.defaultBranch}..HEAD`],
      { cwd: ws, secret: pat, log },
    );
    const touchesWorkflows = changedFiles
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .some((f) => f.startsWith(".github/workflows/"));
    if (touchesWorkflows && !/workflow/i.test(planMd)) {
      throw new ExecutionError(
        "workflow_change_not_in_plan",
        "diff touches .github/workflows/** but the approved plan never mentions workflows",
      );
    }

    // -----------------------------------------------------------------------
    // 5. Push (worker publishes; token injected ONLY here, array form).
    // -----------------------------------------------------------------------
    if (branch === repo.defaultBranch) {
      throw new ExecutionError("push_refused", `refusing to push to default branch ${repo.defaultBranch}`);
    }
    await setStatus(executionId, { status: "pushing" });
    // Explicit lease: bare --force-with-lease relies on a remote-tracking ref
    // for the branch, which a fresh `clone --depth` (implies --single-branch)
    // pushing to a URL never has — git then rejects with "stale info" whenever
    // the remote branch already exists (e.g. a prior attempt failed between
    // push and PR creation), bricking every retry. Query the remote SHA and
    // supply it as the expected value; empty = "branch must not exist yet".
    const lsRemote = await git(["ls-remote", tokenUrl, `refs/heads/${branch}`], {
      cwd: ws,
      secret: pat,
      log,
    });
    const remoteSha = lsRemote.split(/\s+/)[0] ?? "";
    await git(
      ["push", `--force-with-lease=refs/heads/${branch}:${remoteSha}`, tokenUrl, `HEAD:refs/heads/${branch}`],
      { cwd: ws, secret: pat, log },
    );

    const commitSha = await git(["rev-parse", "HEAD"], { cwd: ws, secret: pat, log });

    // -----------------------------------------------------------------------
    // 6. Open the PR.
    // -----------------------------------------------------------------------
    const prBody = [
      `Automated change generated by Standup from a human-approved plan.`,
      "",
      `Refs #${issueNumber}`,
      "",
      "## Approved plan",
      "",
      planMd,
      "",
      "---",
      "",
      "> [!WARNING]",
      "> This branch was written by an AI agent executing the approved plan above.",
      "> Review the diff carefully before merging.",
    ].join("\n");

    const pr = await octokit.rest.pulls.create({
      owner: repo.owner,
      repo: repo.name,
      base: repo.defaultBranch,
      head: branch,
      // Capped at GitHub's 256-char title limit (422 otherwise).
      title: buildPrTitle(issueTitle, issueNumber),
      body: prBody,
    });

    await setStatus(executionId, {
      status: "pr_opened",
      prUrl: pr.data.html_url,
      prNumber: pr.data.number,
      commitSha,
      finishedAt: new Date(),
    });
    await db
      .update(plans)
      .set({ status: "executed", updatedAt: new Date() })
      .where(eq(plans.id, execution.planId));
    await log("system", `PR opened: ${pr.data.html_url}`);

    return { prUrl: pr.data.html_url, branch };
  } catch (e) {
    const message = scrubSecret(e instanceof Error ? e.message : String(e), pat).slice(0, 2000);
    await log("system", `execution failed: ${message}`);
    await setStatus(executionId, { status: "failed", error: message, finishedAt: new Date() });
    // Plan reset to 'approved' happens in the worker handler (Group B).
    throw e;
  } finally {
    if (ws) {
      await rm(ws, { recursive: true, force: true }).catch((e) => {
        console.error("[executor] failed to remove workspace:", e instanceof Error ? e.message : e);
      });
    }
  }
}
