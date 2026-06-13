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

> **Heads-up:** `npm run db:migrate`, `npm run dev:worker`, and `npm run worker`
> run through `tsx`, which does **not** auto-load `.env` (only `npm run dev` /
> Next.js does). When using a hand-managed `.env`, pass it explicitly:
> `npx tsx --env-file=.env scripts/migrate.ts` and
> `npx tsx --env-file=.env worker/index.ts`. See
> [Onboarding](#onboarding-local-step-by-step) below.

## Onboarding (local, step by step)

A complete first-time setup against a **local system Postgres** (not the Docker
`postgres` service). Skip steps you've already done.

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

Standup expects the role/database referenced by `DATABASE_URL`
(`postgres://standup:standup@localhost:5432/standup` by default). With a local
Postgres server already running, create them once:

```bash
sudo -u postgres psql -c "CREATE ROLE standup WITH LOGIN PASSWORD 'standup';"
sudo -u postgres psql -c "CREATE DATABASE standup OWNER standup;"
```

Verify the connection string resolves:

```bash
psql "postgres://standup:standup@localhost:5432/standup" -c '\conninfo'
```

(Postgres 16+ is fine — the schema uses only standard types.)

### 3. Configure `.env`

```bash
cp .env.example .env
```

Then fill it in:

- **`AUTH_SECRET`** and **`SECRETS_ENCRYPTION_KEY`** — generate each with
  `openssl rand -base64 32`. (`SECRETS_ENCRYPTION_KEY` must decode to exactly 32
  bytes, which `rand -base64 32` produces.)
- **`AUTH_GITHUB_ID`** / **`AUTH_GITHUB_SECRET`** — create a GitHub OAuth app at
  <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**:
  - **Homepage URL**: `http://localhost:3000`
  - **Authorization callback URL**:
    `http://localhost:3000/api/auth/callback/github`

  Copy the **Client ID** into `AUTH_GITHUB_ID`, generate a client secret and copy
  it into `AUTH_GITHUB_SECRET`.
- **`ALLOWED_GITHUB_LOGINS`** — comma-separated GitHub usernames allowed to sign
  in (e.g. your own login).
- `DATABASE_URL` / `AUTH_URL` — keep the defaults for local dev.
- `GITHUB_PAT` / `CLAUDE_CODE_OAUTH_TOKEN` — leave commented out; configure them
  in the dashboard Settings UI instead (stored encrypted).

### 4. Apply migrations

```bash
npx tsx --env-file=.env scripts/migrate.ts
```

This creates the app tables (`repos`, `issues`, `plans`, `plan_versions`, `runs`,
`run_items`, `executions`, `execution_logs`, `settings`, `users`, `allowlist`)
plus the pg-boss schema. Confirm with
`psql "$DATABASE_URL" -c '\dt'`.

### 5. Start the web app and worker

In two terminals:

```bash
npm run dev                              # web on http://localhost:3000
npx tsx --env-file=.env worker/index.ts  # worker
```

### 6. First run in the dashboard

1. Open <http://localhost:3000> and **Sign in with GitHub** (your login must be
   in `ALLOWED_GITHUB_LOGINS`).
2. Go to **Settings**:
   - Paste a GitHub **fine-grained PAT** (Contents R/W, Issues R, PRs R/W) and
     validate it.
   - Paste your **Claude OAuth token** (from `claude setup-token`, needs Claude
     Pro/Max).
   - Add **watched repos** as `owner/name`.
   - Optionally adjust the schedule (default `0 7 * * *` UTC), timezone, max
     issues per run, and planner/executor models.
3. Press **Run now** (or wait for the morning cron). The worker syncs open
   issues and Claude drafts a plan per issue. Track progress under **Runs**.
4. On the **dashboard**, open an issue to **edit / approve / reject** its plan.
5. On an *approved* plan, click **Execute**. The worker clones the repo, runs the
   executor agent, and opens a PR — watch live logs on the execution page.

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
