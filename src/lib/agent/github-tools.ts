/**
 * Read-only GitHub MCP tools for the planner agent.
 *
 * Built with the real Agent SDK v0.3.173 API:
 *  - `tool(name, description, zodRawShape, handler)` — inputSchema is a plain
 *    object of zod schemas (a raw shape, NOT z.object(...)); zod 4 supported.
 *  - `createSdkMcpServer({ name, version, tools })` returns an in-process
 *    McpSdkServerConfigWithInstance that goes straight into Options.mcpServers.
 *  - Handlers return MCP CallToolResult: { content: [{type:'text', text}], isError? }.
 *
 * The PAT never leaves this module: it lives inside the Octokit instance held
 * by the tool-handler closures. Every handler catches and returns
 * { isError: true } — it never throws into the agent loop.
 *
 * Framework-agnostic: no next/react imports.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Octokit } from "octokit";
import { z } from "zod";

/** MCP-qualified tool names, for callers building allowedTools lists. */
export const GITHUB_PLANNER_TOOL_NAMES = [
  "mcp__github__repo_tree",
  "mcp__github__list_directory",
  "mcp__github__read_file",
  "mcp__github__search_code",
  "mcp__github__get_issue",
  "mcp__github__list_issue_comments",
] as const;

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

function err(e: unknown, context: string): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text", text: `Error (${context}): ${message}` }],
    isError: true,
  };
}

const MAX_TREE_ENTRIES = 400;
const MAX_FILE_BYTES = 100 * 1024; // 100KB cap on returned file text
const DEFAULT_READ_LINES = 400;
const MAX_SEARCH_RESULTS = 20;
const MAX_COMMENTS = 30;
const MAX_COMMENT_CHARS = 3000;

/**
 * In-process token bucket: at most `capacity` calls per `windowMs`.
 * When exhausted, the caller sleeps until the oldest call leaves the window.
 * GitHub's code-search limit is 10/min for authenticated users; we stay at 8.
 */
export class TokenBucket {
  private timestamps: number[] = [];

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.capacity) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0];
      const waitMs = Math.max(50, oldest + this.windowMs - now);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function decodeContent(data: { content?: string; encoding?: string }): string {
  if (!data.content) return "";
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf8");
  }
  return data.content;
}

/**
 * Build the in-process 'github' MCP server with read-only repository tools,
 * scoped to a single owner/repo. Tool names surface to the model as
 * mcp__github__<tool>.
 */
export function buildGithubPlannerServer(octokit: Octokit, owner: string, repo: string) {
  const searchBucket = new TokenBucket(8, 60_000);

  const repoTree = tool(
    "repo_tree",
    `Full recursive file listing of ${owner}/${repo} (default branch). Returns up to ${MAX_TREE_ENTRIES} file paths. Use path_prefix to narrow large repos.`,
    {
      path_prefix: z
        .string()
        .optional()
        .describe("Only return paths starting with this prefix, e.g. 'src/lib/'"),
    },
    async ({ path_prefix }) => {
      try {
        const res = await octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: "HEAD",
          recursive: "1",
        });
        let blobs = res.data.tree.filter((entry) => entry.type === "blob" && entry.path);
        if (path_prefix) {
          blobs = blobs.filter((entry) => entry.path!.startsWith(path_prefix));
        }
        const total = blobs.length;
        const capped = blobs.slice(0, MAX_TREE_ENTRIES);
        const lines = capped.map((entry) => `${entry.path}${entry.size != null ? ` (${entry.size}B)` : ""}`);
        const notes: string[] = [];
        if (res.data.truncated) {
          notes.push("NOTE: GitHub truncated the tree listing (very large repo) — use path_prefix or list_directory.");
        }
        if (total > MAX_TREE_ENTRIES) {
          notes.push(`NOTE: showing ${MAX_TREE_ENTRIES} of ${total} files — narrow with path_prefix.`);
        }
        return ok([...notes, ...lines].join("\n") || "(no files matched)");
      } catch (e) {
        return err(e, "repo_tree");
      }
    },
  );

  const listDirectory = tool(
    "list_directory",
    `List the entries of one directory in ${owner}/${repo}. Use '' or '.' for the repo root.`,
    {
      path: z.string().describe("Directory path relative to the repo root, e.g. 'src/lib'"),
    },
    async ({ path }) => {
      try {
        const cleanPath = path === "." ? "" : path.replace(/^\/+|\/+$/g, "");
        const res = await octokit.rest.repos.getContent({ owner, repo, path: cleanPath });
        if (!Array.isArray(res.data)) {
          return ok(`'${path}' is a file, not a directory. Use read_file instead.`);
        }
        const lines = res.data.map(
          (entry) => `${entry.type === "dir" ? "dir " : "file"} ${entry.path}${entry.type === "file" ? ` (${entry.size}B)` : ""}`,
        );
        return ok(lines.join("\n") || "(empty directory)");
      } catch (e) {
        return err(e, "list_directory");
      }
    },
  );

  const readFile = tool(
    "read_file",
    `Read a file from ${owner}/${repo} with numbered lines. Defaults to the first ${DEFAULT_READ_LINES} lines; pass start_line/end_line for other ranges. Output is capped at 100KB.`,
    {
      path: z.string().describe("File path relative to the repo root"),
      start_line: z.number().int().min(1).optional().describe("1-based first line to return (default 1)"),
      end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`1-based last line to return (default start_line + ${DEFAULT_READ_LINES - 1})`),
    },
    async ({ path, start_line, end_line }) => {
      try {
        const res = await octokit.rest.repos.getContent({ owner, repo, path });
        if (Array.isArray(res.data)) {
          return ok(`'${path}' is a directory, not a file. Use list_directory instead.`);
        }
        if (res.data.type !== "file") {
          return ok(`'${path}' is a ${res.data.type}, not a regular file.`);
        }
        const text = decodeContent(res.data);
        const allLines = text.split("\n");
        const start = start_line ?? 1;
        const end = end_line ?? start + DEFAULT_READ_LINES - 1;
        if (start > allLines.length) {
          return ok(`(file has only ${allLines.length} lines — start_line ${start} is past the end)`);
        }
        const window = allLines.slice(start - 1, end);
        let body = window.map((line, i) => `${start + i}\t${line}`).join("\n");
        let note = "";
        if (body.length > MAX_FILE_BYTES) {
          body = body.slice(0, MAX_FILE_BYTES);
          note = `\n[output truncated at 100KB — request a smaller line range]`;
        }
        const trailer =
          end < allLines.length ? `\n[showing lines ${start}-${Math.min(end, allLines.length)} of ${allLines.length}]` : "";
        return ok(body + note + trailer);
      } catch (e) {
        return err(e, "read_file");
      }
    },
  );

  const searchCode = tool(
    "search_code",
    `Search code in ${owner}/${repo} (GitHub code search). Returns up to ${MAX_SEARCH_RESULTS} matches with text fragments. RATE LIMITED to 8 searches/min — prefer repo_tree + read_file when you already know where to look.`,
    {
      query: z.string().describe("Code search query, e.g. 'handleSubmit' or 'TODO language:typescript'"),
    },
    async ({ query: searchQuery }) => {
      try {
        await searchBucket.take();
        const res = await octokit.rest.search.code({
          q: `${searchQuery} repo:${owner}/${repo}`,
          per_page: MAX_SEARCH_RESULTS,
          headers: { accept: "application/vnd.github.text-match+json" },
        });
        if (res.data.items.length === 0) return ok("No matches.");
        const blocks = res.data.items.map((item) => {
          const fragments = (item.text_matches ?? [])
            .map((m) => (m.fragment ?? "").slice(0, 400))
            .filter(Boolean)
            .join("\n---\n");
          return `${item.path}\n${fragments || "(no fragment)"}`;
        });
        return ok(
          `${res.data.total_count} total matches (showing ${res.data.items.length}):\n\n${blocks.join("\n\n")}`,
        );
      } catch (e) {
        return err(e, "search_code");
      }
    },
  );

  const getIssue = tool(
    "get_issue",
    `Fetch one issue from ${owner}/${repo} (title, state, labels, body).`,
    {
      number: z.number().int().min(1).describe("Issue number"),
    },
    async ({ number }) => {
      try {
        const res = await octokit.rest.issues.get({ owner, repo, issue_number: number });
        const issue = res.data;
        const labels = issue.labels
          .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
          .filter(Boolean)
          .join(", ");
        return ok(
          [
            `#${issue.number} ${issue.title}`,
            `state: ${issue.state}  author: ${issue.user?.login ?? "unknown"}  comments: ${issue.comments}`,
            `labels: ${labels || "(none)"}`,
            "",
            (issue.body ?? "(no body)").slice(0, 20_000),
          ].join("\n"),
        );
      } catch (e) {
        return err(e, "get_issue");
      }
    },
  );

  const listIssueComments = tool(
    "list_issue_comments",
    `List up to ${MAX_COMMENTS} comments on an issue in ${owner}/${repo}. Bodies are truncated to ${MAX_COMMENT_CHARS} chars.`,
    {
      number: z.number().int().min(1).describe("Issue number"),
    },
    async ({ number }) => {
      try {
        const res = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: number,
          per_page: MAX_COMMENTS,
        });
        if (res.data.length === 0) return ok("No comments.");
        const blocks = res.data.map((c) => {
          let body = c.body ?? "";
          if (body.length > MAX_COMMENT_CHARS) {
            body = `${body.slice(0, MAX_COMMENT_CHARS)}… [truncated]`;
          }
          return `@${c.user?.login ?? "unknown"} (${c.created_at}):\n${body}`;
        });
        return ok(blocks.join("\n\n---\n\n"));
      } catch (e) {
        return err(e, "list_issue_comments");
      }
    },
  );

  return createSdkMcpServer({
    name: "github",
    version: "1.0.0",
    instructions:
      `Read-only access to the GitHub repository ${owner}/${repo}. ` +
      `Use repo_tree/list_directory to orient, read_file to inspect code, and search_code sparingly (rate limited).`,
    tools: [repoTree, listDirectory, readFile, searchCode, getIssue, listIssueComments],
  });
}
