# Standup

Self-hostable web app that gives you a morning standup for your GitHub backlog:

1. Every morning a **worker** fetches open issues from your watched repos.
2. For each issue, a planner agent (Claude, via the Claude Agent SDK with a
   subscription OAuth token) generates a **solving plan**.
3. You review, edit, and approve plans in a **dashboard**.
4. Approved plans are **executed** by an agent: ephemeral clone → branch → PR.

Stack: Next.js (App Router) + Postgres. pg-boss handles queue + cron — no
Redis, no extra brokers. One npm package, two processes: `web` (`next start`)
and `worker` (`tsx worker/index.ts`).

## Quickstart

```bash
cp .env.example .env
# fill in AUTH_SECRET, AUTH_GITHUB_ID/SECRET, SECRETS_ENCRYPTION_KEY,
# ALLOWED_GITHUB_LOGINS (see the table below)
docker compose up
```

Then open http://localhost:3000. The `migrate` service applies database
migrations before `app` and `worker` start.

### Local development (without Docker)

```bash
npm install
docker compose up postgres -d   # or any local Postgres 17
npm run db:migrate
npm run dev          # web on :3000
npm run dev:worker   # worker (separate terminal)
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Default: `postgres://standup:standup@localhost:5432/standup` |
| `AUTH_SECRET` | yes | Auth.js session secret — `openssl rand -base64 32` |
| `AUTH_GITHUB_ID` | yes | GitHub OAuth app client ID (dashboard sign-in) |
| `AUTH_GITHUB_SECRET` | yes | GitHub OAuth app client secret |
| `AUTH_URL` | yes | Canonical app URL, e.g. `http://localhost:3000` |
| `SECRETS_ENCRYPTION_KEY` | yes | AES-256-GCM key for secrets at rest (base64, exactly 32 bytes) — `openssl rand -base64 32` |
| `ALLOWED_GITHUB_LOGINS` | yes | Comma-separated GitHub usernames allowed to sign in |
| `GITHUB_PAT` | no | Bootstrap fallback GitHub token (before settings UI is configured) |
| `CLAUDE_CODE_OAUTH_TOKEN` | no | Bootstrap fallback Claude subscription OAuth token |
| `PLANNER_MODEL` | no | Planner model (default `claude-sonnet-4-6`) |
| `EXECUTOR_MODEL` | no | Executor model (default `claude-opus-4-8`) |

## Architecture

```
                    ┌─────────────────────────────┐
                    │           Postgres          │
                    │  app schema  +  pg-boss     │
                    └────────▲───────────▲────────┘
                             │           │
              ┌──────────────┴──┐   ┌────┴────────────────┐
              │  web (Next.js)  │   │  worker (tsx)       │
              │  dashboard,     │   │  pg-boss queues:    │
              │  review/approve │   │  sync → plan → exec │
              │  plans, auth    │   │  (cron each morning)│
              └─────────────────┘   └─────────┬───────────┘
                                              │
                                   GitHub API + Claude Agent SDK
                                   (clone → branch → PR)
```

- `src/db/schema.ts` is the central data contract (repos, issues, plans,
  plan_versions, runs, run_items, executions, execution_logs).
- `src/lib/crypto.ts` encrypts stored secrets (AES-256-GCM).
- `src/lib/agent/plan-schema.ts` defines the plan shape (zod + JSON Schema)
  and its canonical markdown rendering.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run dev:worker` | Worker with file watching |
| `npm run build` / `npm run start` | Production web build / serve |
| `npm run worker` | Worker process |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `npm run db:generate` | Generate SQL migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
