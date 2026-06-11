/**
 * Planner — generates a structured solving plan for one synced GitHub issue.
 *
 * Pipeline: load issue+repo from DB -> refresh comments from GitHub ->
 * pre-fetch top-level tree -> run the Claude agent with read-only github MCP
 * tools and native JSON-schema structured output -> validate with PlanZ.
 *
 * Framework-agnostic: no next/react imports (worker calls this).
 */
import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";

import { getDb } from "../../db/client";
import { issues, repos } from "../../db/schema";
import { getOctokit } from "../github";
import { computeContentHash } from "../issues-sync";
import { getSettingValue } from "../settings";
import { buildGithubPlannerServer, GITHUB_PLANNER_TOOL_NAMES } from "./github-tools";
import { PlanZ, PLAN_JSON_SCHEMA, renderPlanMarkdown, type Plan } from "./plan-schema";
import { PLANNER_SYSTEM_PROMPT, plannerTaskPrompt } from "./prompts";
import { runAgent } from "./runAgent";

const PLANNER_MAX_TURNS = 50;
const PLANNER_TIMEOUT_MS = 15 * 60 * 1000;
const COMMENTS_TO_FETCH = 30;

async function fetchFreshComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ comments: Array<{ author: string; body: string }>; ids: number[] } | null> {
  try {
    const res = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: COMMENTS_TO_FETCH,
    });
    return {
      comments: res.data.map((c) => ({
        author: c.user?.login ?? "unknown",
        body: (c.body ?? "").slice(0, 3000),
      })),
      ids: res.data.map((c) => c.id),
    };
  } catch (e) {
    // Comments are enrichment, not a hard dependency — plan from the body alone.
    console.error("[planner] failed to refresh comments:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function fetchTopLevelTree(octokit: Octokit, owner: string, repo: string): Promise<string> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: "" });
    if (!Array.isArray(res.data)) return "(unavailable)";
    return res.data
      .map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name))
      .join("\n");
  } catch (e) {
    console.error("[planner] failed to fetch top-level tree:", e instanceof Error ? e.message : e);
    return "(unavailable — use mcp__github__repo_tree)";
  }
}

export async function generatePlanForIssue(issueId: number): Promise<{
  plan: Plan;
  markdown: string;
  /** Content hash of the issue snapshot the planner ACTUALLY consumed. */
  basedOnHash: string;
  stats: { numTurns: number; durationMs: number; model: string; sessionId?: string };
}> {
  const db = getDb();

  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) throw new Error(`issue ${issueId} not found`);
  if (issue.number == null) throw new Error(`issue ${issueId} has no GitHub issue number`);

  const [repo] = await db.select().from(repos).where(eq(repos.id, issue.repoId)).limit(1);
  if (!repo) throw new Error(`repo ${issue.repoId} not found for issue ${issueId}`);

  const octokit = await getOctokit();

  // Freshness: re-pull the latest comments instead of trusting the sync snapshot.
  const fresh = await fetchFreshComments(octokit, repo.owner, repo.name, issue.number);
  const comments = fresh?.comments ?? [];
  const topLevelTree = await fetchTopLevelTree(octokit, repo.owner, repo.name);

  const labels = Array.isArray(issue.labels) ? (issue.labels as unknown[]).map(String) : [];

  // Pin the plan to the content the planner consumed: the title/body/labels
  // snapshot read at the START of this (multi-minute) run plus the freshly
  // fetched comment ids. NEVER re-read the issue row after generation — a
  // concurrent sync can update it mid-run and the recorded hash would then
  // claim freshness for content the planner never saw, defeating every
  // staleness check. When the comment refresh failed we fall back to the
  // synced snapshot's hash (matching the snapshot we planned from).
  const basedOnHash = fresh
    ? computeContentHash({
        title: issue.title ?? "",
        body: issue.body,
        labels,
        commentIds: fresh.ids,
        commentsCount: issue.commentsCount ?? 0,
      })
    : issue.contentHash;

  const model = await getSettingValue<string>("planner_model", "claude-sonnet-4-6");

  const prompt = plannerTaskPrompt({
    repoFullName: `${repo.owner}/${repo.name}`,
    defaultBranch: repo.defaultBranch,
    topLevelTree,
    issue: {
      number: issue.number,
      title: issue.title ?? "(untitled)",
      body: issue.body,
      labels,
      comments,
    },
  });

  const result = await runAgent({
    prompt,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    mcpServers: {
      github: buildGithubPlannerServer(octokit, repo.owner, repo.name),
    },
    // Pre-approve the MCP tools both as a server-level rule and per-tool —
    // with permissionMode 'dontAsk', anything not listed here is denied.
    allowedTools: ["mcp__github", ...GITHUB_PLANNER_TOOL_NAMES],
    // Strip ALL built-in tools (Bash/Read/WebFetch/...): the planner may only
    // see the repo through the read-only github MCP server.
    builtinTools: [],
    permissionMode: "dontAsk",
    model,
    maxTurns: PLANNER_MAX_TURNS,
    timeoutMs: PLANNER_TIMEOUT_MS,
    outputSchema: PLAN_JSON_SCHEMA,
  });

  const plan = PlanZ.parse(result.structuredOutput);
  const markdown = renderPlanMarkdown(plan);

  return { plan, markdown, basedOnHash, stats: result.stats };
}
