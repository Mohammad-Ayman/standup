# CLAUDE.md

## What Standup is

Self-hostable app: a worker fetches open GitHub issues from watched repos each
morning, generates a per-issue solving plan with Claude (Claude Agent SDK,
subscription OAuth token), the user reviews/approves plans in a dashboard, and
approved plans are executed (ephemeral clone → branch → PR).

Stack: Next.js App Router + Postgres only. pg-boss for queue/cron. Single npm
package; two processes: web (`next start`) and worker (`tsx worker/index.ts`).

## Layout

| Path | Purpose |
| --- | --- |
| `src/app/` | Next.js App Router (pages, API routes) |
| `src/db/schema.ts` | Drizzle schema — THE central data contract |
| `src/db/client.ts` | Lazy pool/db singletons (`getPool`, `getDb`, `closePool`) |
| `src/db/migrations/` | Generated SQL migrations (drizzle-kit) |
| `src/lib/crypto.ts` | AES-256-GCM secrets crypto (`v1:<iv>:<ct>:<tag>`) |
| `src/lib/agent/plan-schema.ts` | Plan contract: `PlanZ`, `PLAN_JSON_SCHEMA`, `renderPlanMarkdown` |
| `worker/index.ts` | Worker entrypoint (pg-boss) |
| `scripts/migrate.ts` | Programmatic migration runner |

## Conventions

- **Strict TypeScript** — no `any` without justification.
- **zod at boundaries** — validate all external input (API routes, agent
  output, GitHub payloads) with zod schemas.
- **`src/lib/**` and `src/db/**` are framework-agnostic** — no `next` or
  `react` imports there. The worker imports ONLY from those directories.
- Schema changes go through `src/db/schema.ts` → `npm run db:generate` →
  commit the generated SQL. Never hand-edit applied migrations.
- Secrets are stored encrypted via `encryptSecret`/`decryptSecret`; API
  responses expose only `maskSecret` output.
- Tests live next to the module (`*.test.ts`, vitest).

## Commands

`npm run dev` · `npm run dev:worker` · `npm run build` · `npm run start` ·
`npm run worker` · `npm run typecheck` · `npm run lint` · `npm run test` ·
`npm run db:generate` · `npm run db:migrate`
