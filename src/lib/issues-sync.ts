/**
 * Issue sync + plan-candidate selection.
 *
 * - computeContentHash: stable sha256 over the issue content the planner
 *   cares about (title, body, labels, comment ids) — order-insensitive for
 *   labels/commentIds, body null ≡ ''.
 * - syncRepoIssues: incremental sync of a repo's issues (state=all, `since`
 *   with a 5-minute overlap), skipping pull requests, upserting by
 *   github_issue_id.
 * - selectPlanCandidates: open issues from enabled repos that need a (new)
 *   plan, superseding stale drafts along the way.
 *
 * Framework-agnostic: no next/react imports allowed here.
 */
import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { issues, repos } from "../db/schema";
import { getOctokit } from "./github";
import { getSettingValue } from "./settings";

const SYNC_OVERLAP_MS = 5 * 60 * 1000;
const MAX_COMMENTS = 30;

export function computeContentHash(input: {
  title: string;
  body: string | null;
  labels: string[];
  commentIds: number[];
  /**
   * Total comment count from the issue payload. Only the first MAX_COMMENTS
   * comment ids are hashed, so without the count an issue with 30+ comments
   * would never re-hash on new comments and its plans could never go stale.
   * Optional (omitted = excluded from the hash) to keep the contract
   * signature backward-compatible.
   */
  commentsCount?: number;
}): string {
  const canonical = {
    title: input.title,
    body: input.body ?? "",
    labels: [...input.labels].sort(),
    commentIds: [...input.commentIds].sort((a, b) => a - b),
    ...(input.commentsCount !== undefined ? { commentsCount: input.commentsCount } : {}),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Sync one repo's issues from GitHub into the issues table.
 * Returns { scanned, changed }: scanned = non-PR issues returned by the API,
 * changed = rows inserted or whose content hash changed.
 */
export async function syncRepoIssues(
  repoId: number,
): Promise<{ scanned: number; changed: number }> {
  const db = getDb();
  const [repo] = await db
    .select()
    .from(repos)
    .where(eq(repos.id, repoId))
    .limit(1);
  if (!repo) {
    throw new Error(`repo ${repoId} not found`);
  }

  const syncStartedAt = new Date();
  const octokit = await getOctokit();

  // Snapshot of what we already have, keyed by github_issue_id.
  const existingRows = await db
    .select({
      githubIssueId: issues.githubIssueId,
      githubUpdatedAt: issues.githubUpdatedAt,
      contentHash: issues.contentHash,
    })
    .from(issues)
    .where(eq(issues.repoId, repoId));
  const existingById = new Map<
    number,
    { githubUpdatedAt: Date; contentHash: string }
  >();
  for (const row of existingRows) {
    if (row.githubIssueId !== null) {
      existingById.set(row.githubIssueId, {
        githubUpdatedAt: row.githubUpdatedAt,
        contentHash: row.contentHash,
      });
    }
  }

  // Incremental window with a 5-minute overlap; full scan when never synced.
  const since = repo.lastSyncedAt
    ? new Date(repo.lastSyncedAt.getTime() - SYNC_OVERLAP_MS).toISOString()
    : undefined;

  const items = await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    owner: repo.owner,
    repo: repo.name,
    state: "all",
    per_page: 100,
    ...(since ? { since } : {}),
  });

  let scanned = 0;
  let changed = 0;

  for (const item of items) {
    // The issues endpoint returns PRs too — skip them.
    if (item.pull_request) {
      continue;
    }
    scanned += 1;

    const existing = existingById.get(item.id);
    const githubUpdatedAt = new Date(item.updated_at);

    // Unchanged since last sync — nothing to fetch or write.
    if (
      existing &&
      existing.githubUpdatedAt.getTime() === githubUpdatedAt.getTime()
    ) {
      continue;
    }

    // Fetch up to 30 comment ids only for new/changed issues.
    let commentIds: number[] = [];
    if (item.comments > 0) {
      const { data: comments } = await octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: repo.owner,
          repo: repo.name,
          issue_number: item.number,
          per_page: MAX_COMMENTS,
        },
      );
      commentIds = comments.map((c) => c.id);
    }

    const labels = (item.labels ?? [])
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter((n) => n.length > 0);
    const body = item.body ?? null;
    const contentHash = computeContentHash({
      title: item.title,
      body,
      labels,
      commentIds,
      commentsCount: item.comments,
    });
    const state: "open" | "closed" =
      item.state === "closed" ? "closed" : "open";
    const now = new Date();

    await db
      .insert(issues)
      .values({
        repoId,
        githubIssueId: item.id,
        number: item.number,
        title: item.title,
        body,
        state,
        labels,
        authorLogin: item.user?.login ?? null,
        commentsCount: item.comments,
        githubUpdatedAt,
        contentHash,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: issues.githubIssueId,
        set: {
          title: item.title,
          body,
          state,
          labels,
          commentsCount: item.comments,
          githubUpdatedAt,
          contentHash,
          syncedAt: now,
        },
      });

    if (!existing || existing.contentHash !== contentHash) {
      changed += 1;
    }
  }

  await db
    .update(repos)
    .set({ lastSyncedAt: syncStartedAt })
    .where(eq(repos.id, repoId));

  return { scanned, changed };
}

/**
 * Pick open issues (enabled repos) that need a plan, ordered by
 * github_updated_at desc, limited to maxIssues. Returns issue ids.
 *
 * Rules:
 * - any approved/executing/executed plan → excluded (done or in flight)
 * - fresh draft (based_on_hash == content_hash) → excluded
 * - stale draft (hash differs) → draft is marked 'superseded', issue included
 * - rejected plans only → included iff replan_rejected (default true) AND the
 *   latest rejected plan's based_on_hash differs from the current content hash
 * - no blocking plans at all → included
 */
export async function selectPlanCandidates(
  maxIssues: number,
): Promise<number[]> {
  const db = getDb();
  const replanRejected = await getSettingValue<boolean>("replan_rejected", true);

  // (b) Supersede stale drafts for open issues in enabled repos first.
  await db.execute(sql`
    update plans p
    set status = 'superseded', updated_at = now()
    from issues i
    join repos r on r.id = i.repo_id
    where p.issue_id = i.id
      and p.status = 'draft'
      and p.based_on_hash <> i.content_hash
      and i.state = 'open'
      and r.enabled = true
  `);

  const result = await db.execute<{ id: string | number }>(sql`
    select i.id as id
    from issues i
    join repos r on r.id = i.repo_id
    where i.state = 'open'
      and r.enabled = true
      and not exists (
        select 1
        from plans p
        where p.issue_id = i.id
          and p.status in ('draft', 'approved', 'executing', 'executed')
      )
      and (
        not exists (
          select 1 from plans p where p.issue_id = i.id and p.status = 'rejected'
        )
        or (
          ${replanRejected}
          and coalesce((
            select p.based_on_hash
            from plans p
            where p.issue_id = i.id and p.status = 'rejected'
            order by p.rejected_at desc nulls last, p.id desc
            limit 1
          ), '') <> i.content_hash
        )
      )
    order by i.github_updated_at desc
    limit ${maxIssues}
  `);

  return result.rows.map((row) => Number(row.id));
}
