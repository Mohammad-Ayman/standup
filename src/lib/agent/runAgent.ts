/**
 * runAgent — the ONLY place in the codebase that invokes the Claude Agent SDK.
 *
 * Real SDK API (v0.3.173, verified against node_modules sdk.d.ts):
 *  - `query({ prompt, options }): Query` where Query extends AsyncGenerator<SDKMessage>
 *  - Options fields used here: abortController, allowedTools, disallowedTools,
 *    tools (string[] | {type:'preset',preset:'claude_code'} — `[]` disables ALL
 *    built-in tools), env (REPLACES the subprocess env entirely — not merged),
 *    mcpServers, strictMcpConfig, settingSources ([] = hermetic, no filesystem
 *    settings / CLAUDE.md), systemPrompt (string | string[] | claude_code preset
 *    with optional `append`), model, fallbackModel, maxTurns, cwd,
 *    permissionMode ('default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'),
 *    allowDangerouslySkipPermissions, persistSession, outputFormat
 *    ({ type: 'json_schema', schema }) — structured output IS supported natively;
 *    the result message carries `structured_output?: unknown` on success and an
 *    'error_max_structured_output_retries' result subtype on failure.
 *  - SDKMessage union members handled: SDKAssistantMessage {message: BetaMessage,
 *    error?}, SDKUserMessage (tool results), SDKSystemMessage {subtype:'init',
 *    model, session_id}, SDKResultMessage (success | error subtypes),
 *    SDKRateLimitEvent {rate_limit_info:{status,resetsAt?}}, SDKAPIRetryMessage.
 *
 * Security invariants:
 *  - child env is built from scratch (the SDK replaces, not merges):
 *    only PATH/HOME/shell basics + CLAUDE_CODE_OAUTH_TOKEN.
 *  - ANTHROPIC_API_KEY is NEVER passed (subscription OAuth only).
 *  - No GITHUB_* / *_PAT / GH_* variable is ever passed to the agent process.
 *
 * ---------------------------------------------------------------------------
 * SEAM (documented, not implemented): subprocess fallback.
 * If the SDK ever becomes unusable (e.g. version skew with the installed CLI),
 * this module is the only file to change. The replacement implementation would
 * spawn `claude -p <prompt> --output-format stream-json --verbose
 * --max-turns N --model M [--mcp-config ...] [--allowed-tools ...]` with the
 * same minimal env, parse one JSON object per stdout line into the same
 * AgentEvent mapping below, and resolve on the `{"type":"result"}` line.
 * Callers (planner.ts / executor.ts) would not change.
 * ---------------------------------------------------------------------------
 *
 * Framework-agnostic: no next/react imports.
 */
import {
  AbortError,
  query,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { getSecret } from "../settings";
import { parseResumeAt, toClassifiedError, unixToDate, UsageLimitError } from "./limits";

export type AgentEvent = { kind: string; summary: string; raw: unknown };

export interface RunAgentOptions {
  prompt: string;
  /** Passed through verbatim to SDK Options.systemPrompt. */
  systemPrompt?: Options["systemPrompt"];
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * Base set of built-in tools (SDK Options.tools).
   * `[]` disables every built-in tool (planner mode — MCP only).
   * A list like ['Read','Edit','Bash'] restricts to exactly those (executor mode).
   */
  builtinTools?: string[] | { type: "preset"; preset: "claude_code" };
  /** Headless permission posture. Defaults to 'dontAsk' (deny anything not pre-allowed). */
  permissionMode?: Extract<PermissionMode, "default" | "dontAsk" | "bypassPermissions">;
  cwd?: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  /** JSON Schema for native structured output (SDK Options.outputFormat). */
  outputSchema?: object;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
}

export interface RunAgentResult {
  structuredOutput?: unknown;
  resultText?: string;
  stats: {
    numTurns: number;
    durationMs: number;
    sessionId?: string;
    model: string;
  };
}

/** Env var names that must never reach the agent subprocess. */
const FORBIDDEN_ENV_PATTERNS = [/^ANTHROPIC_/i, /^GITHUB_/i, /^GH_/i, /PAT$/i, /TOKEN$/i];

/**
 * Build the minimal child environment. Options.env REPLACES the subprocess
 * env entirely, so anything not listed here simply does not exist for the
 * agent. CLAUDE_CODE_OAUTH_TOKEN is added by the caller after this.
 */
function buildMinimalEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "USER"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Identify ourselves in the SDK User-Agent (documented SDK env hook).
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "standup/0.1.0";
  // Defense in depth: assert nothing forbidden slipped into the keep-list.
  for (const key of Object.keys(env)) {
    if (key !== "CLAUDE_AGENT_SDK_CLIENT_APP" && FORBIDDEN_ENV_PATTERNS.some((re) => re.test(key))) {
      delete env[key];
    }
  }
  return env;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

function compactJson(value: unknown, max = 300): string {
  try {
    return truncate(JSON.stringify(value) ?? "", max);
  } catch {
    return "[unserializable]";
  }
}

/** Map one SDKMessage to zero or more AgentEvents. */
function toAgentEvents(msg: SDKMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  switch (msg.type) {
    case "assistant": {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          events.push({ kind: "assistant_text", summary: truncate(block.text, 2000), raw: msg });
        } else if (block.type === "tool_use") {
          events.push({
            kind: "tool_use",
            summary: `-> ${block.name} ${compactJson(block.input)}`,
            raw: msg,
          });
        } else if (block.type === "thinking") {
          events.push({
            kind: "thinking",
            summary: truncate(block.thinking ?? "", 500),
            raw: msg,
          });
        }
      }
      if (msg.error) {
        events.push({ kind: "assistant_error", summary: `assistant error: ${msg.error}`, raw: msg });
      }
      break;
    }
    case "user": {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && block.type === "tool_result") {
            const text =
              typeof block.content === "string" ? block.content : compactJson(block.content, 400);
            events.push({
              kind: "tool_result",
              summary: `<- ${block.is_error ? "ERROR " : ""}${truncate(text, 400)}`,
              raw: msg,
            });
          }
        }
      }
      break;
    }
    case "system": {
      if (msg.subtype === "init") {
        events.push({
          kind: "init",
          summary: `session started: model=${msg.model} tools=${msg.tools.length}`,
          raw: msg,
        });
      } else if (msg.subtype === "api_retry") {
        events.push({
          kind: "api_retry",
          summary: `api retry ${msg.attempt}/${msg.max_retries} after ${msg.error} (status ${msg.error_status ?? "n/a"})`,
          raw: msg,
        });
      }
      break;
    }
    case "result": {
      events.push({
        kind: "result",
        summary:
          msg.subtype === "success"
            ? `result: success turns=${msg.num_turns} duration=${msg.duration_ms}ms`
            : `result: ${msg.subtype} turns=${msg.num_turns} duration=${msg.duration_ms}ms errors=${compactJson(
                msg.errors,
                500,
              )}`,
        raw: msg,
      });
      break;
    }
    case "rate_limit_event": {
      events.push({
        kind: "rate_limit",
        summary: `rate limit: status=${msg.rate_limit_info.status} resetsAt=${msg.rate_limit_info.resetsAt ?? "unknown"}`,
        raw: msg,
      });
      break;
    }
    default:
      // Other system/status/task messages are noise for our logs — skip.
      break;
  }
  return events;
}

const AUTH_ASSISTANT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "billing_error"]);
const LIMIT_ASSISTANT_ERRORS = new Set(["rate_limit", "overloaded"]);

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const token = await getSecret("claude_oauth_token");
  if (!token) {
    throw new Error(
      "claude_oauth_token is not configured — set it in Settings or via the CLAUDE_CODE_OAUTH_TOKEN env fallback",
    );
  }

  const env = buildMinimalEnv();
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // EXPLICITLY never set: ANTHROPIC_API_KEY, GITHUB_PAT, GITHUB_TOKEN, GH_TOKEN.

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, opts.timeoutMs);

  // Scrub the OAuth token from ANY text that leaves this function (stderr,
  // event summaries -> execution_logs, error messages). The executor agent
  // runs Bash with the token in its env, so incidental output (`printenv`,
  // `set -x`, env-dumping test scripts) can echo it — it must never persist.
  const scrub = (text: string): string => text.split(token).join("***");

  const stderrTail: string[] = [];

  const options: Options = {
    abortController,
    env,
    cwd: opts.cwd,
    model: opts.model,
    maxTurns: opts.maxTurns,
    systemPrompt: opts.systemPrompt,
    mcpServers: opts.mcpServers,
    strictMcpConfig: true,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    tools: opts.builtinTools,
    permissionMode: opts.permissionMode ?? "dontAsk",
    allowDangerouslySkipPermissions: opts.permissionMode === "bypassPermissions" ? true : undefined,
    settingSources: [], // hermetic: no user/project/local settings, no CLAUDE.md
    persistSession: false, // ephemeral worker runs — nothing to resume
    outputFormat: opts.outputSchema
      ? { type: "json_schema", schema: opts.outputSchema as Record<string, unknown> }
      : undefined,
    stderr: (data: string) => {
      // Keep a short scrubbed tail for error context; never log the token.
      const line = scrub(data).trim();
      if (line) {
        stderrTail.push(truncate(line, 500));
        if (stderrTail.length > 20) stderrTail.shift();
      }
    },
  };

  let resultMsg: Extract<SDKMessage, { type: "result" }> | undefined;
  let sessionId: string | undefined;
  let actualModel = opts.model;

  try {
    const q = query({ prompt: opts.prompt, options });

    for await (const msg of q) {
      for (const ev of toAgentEvents(msg)) {
        if (opts.onEvent) {
          // Token-scrub every summary before it reaches the caller (callers
          // persist summaries to execution_logs and cannot scrub a secret
          // they never hold). `raw` is intentionally NOT forwarded scrubbed —
          // callers must never persist `raw`; summary is the loggable field.
          await opts.onEvent({ ...ev, summary: scrub(ev.summary) });
        }
      }

      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        actualModel = msg.model || actualModel;
      } else if (msg.type === "rate_limit_event" && msg.rate_limit_info.status === "rejected") {
        const resumeAt =
          msg.rate_limit_info.resetsAt !== undefined ? unixToDate(msg.rate_limit_info.resetsAt) : null;
        throw new UsageLimitError(
          `Claude usage limit rejected (type=${msg.rate_limit_info.rateLimitType ?? "unknown"})`,
          resumeAt,
        );
      } else if (msg.type === "assistant" && msg.error) {
        // assistant.error is terminal (the CLI's own retries surface as api_retry first)
        if (AUTH_ASSISTANT_ERRORS.has(msg.error)) {
          throw new Error(`Claude auth error: ${msg.error}`);
        }
        if (LIMIT_ASSISTANT_ERRORS.has(msg.error)) {
          const text = msg.message.content.find((b) => b.type === "text");
          const detail = text && text.type === "text" ? text.text : "";
          throw new UsageLimitError(`Claude ${msg.error}: ${truncate(detail, 300)}`, parseResumeAt(detail));
        }
        // other assistant errors (invalid_request, server_error, ...) — let the
        // run continue; the terminal result message decides the outcome.
      } else if (msg.type === "result") {
        resultMsg = msg;
      }
    }
  } catch (e) {
    if (timedOut) {
      throw new Error(`agent run timed out after ${opts.timeoutMs} ms`);
    }
    if (e instanceof UsageLimitError) throw e;
    if (e instanceof AbortError) {
      throw new Error("agent run aborted");
    }
    // Re-classify unknown stream errors (rate limit / auth shapes come through
    // here when the subprocess dies before emitting a result message).
    const base = scrub(e instanceof Error ? e.message : String(e));
    const context = stderrTail.length > 0 ? `${base}\nstderr: ${stderrTail.slice(-5).join(" | ")}` : base;
    throw toClassifiedError(context);
  } finally {
    clearTimeout(timer);
  }

  if (!resultMsg) {
    throw new Error(
      `agent run ended without a result message${stderrTail.length > 0 ? ` — stderr: ${stderrTail.slice(-5).join(" | ")}` : ""}`,
    );
  }

  if (resultMsg.subtype !== "success") {
    const detail = scrub(resultMsg.errors.join("; ") || resultMsg.subtype);
    if (resultMsg.subtype === "error_max_structured_output_retries") {
      throw new Error(`agent failed to produce valid structured output: ${detail}`);
    }
    if (resultMsg.subtype === "error_max_turns") {
      throw new Error(`agent hit maxTurns (${opts.maxTurns}) without finishing: ${detail}`);
    }
    throw toClassifiedError(`agent run failed (${resultMsg.subtype}): ${detail}`);
  }

  if (opts.outputSchema && resultMsg.structured_output === undefined) {
    throw new Error("agent run succeeded but returned no structured output");
  }

  return {
    structuredOutput: resultMsg.structured_output,
    resultText: resultMsg.result,
    stats: {
      numTurns: resultMsg.num_turns,
      durationMs: resultMsg.duration_ms,
      sessionId: sessionId ?? resultMsg.session_id,
      model: actualModel,
    },
  };
}
