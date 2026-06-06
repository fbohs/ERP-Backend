# CLAUDE.md — ERP Backend (Root)

> This file loads on every session. It is intentionally short. Detail lives in nested `CLAUDE.md`, skills, and `docs/engineering-charter.md`. Read those when the task lands in their area.

## Mission

Open-source ERP backend (accounting, HR, inventory). Money moves, ledgers must reconcile, audit trails are legally meaningful. Correctness > cleverness. Explicit > magic. Reversible > clever.

## Stack (locked, exact)

| Concern         | Version                                        |
| --------------- | ---------------------------------------------- |
| Node.js         | `24.15.0` (LTS "Krypton", through Apr 2028)    |
| TypeScript      | `6.0.x`                                        |
| Fastify         | latest 5.x                                     |
| Prisma          | `7.8.x` (schema + migrations only)             |
| Kysely          | pin exact (currently `0.29.0`; pre-1.0, no LTS — upgrade by CHANGELOG review only) |
| kysely-codegen  | latest (generate `DB` from the live database)  |
| PostgreSQL      | `18` (alpine image)                            |
| Redis / Valkey  | Redis OSS `8.6.x` or Valkey `8.x` (either)     |
| BullMQ          | latest                                         |
| Zod, Pino, Vitest, Supertest, Testcontainers, ESLint, Prettier | latest stable |

Anything outside this list → ADR (`/adr`).

**Package versions are always exact.** No `^` or `~` in `package.json`. Use `pnpm add --save-exact` / `pnpm add --save-dev --save-exact`.

**After adding packages, audit for unused ones.** Grep `src/` for imports of every existing package. Remove anything with zero imports that is not a locked stack dependency (stack deps like `bullmq`, `decimal.js` are retained even if not yet used — they will be). Use `pnpm remove` to remove from both `package.json` and `node_modules`.

## Commands

```bash
pnpm dev                     # dev server with hot reload (loads .env.local automatically)
pnpm build && pnpm start     # compile then run production output

pnpm test                    # run all tests
pnpm exec vitest run <file>  # run one test file, e.g. src/modules/auth/__tests__/auth.routes.test.ts
pnpm test:coverage           # coverage report

pnpm db:migrate              # apply pending migrations (dev)
pnpm db:codegen              # regenerate Kysely DB types from live schema — run after every migration

pnpm lint && pnpm exec tsc --noEmit   # full static check before committing
```

Integration tests (`*.routes.test.ts`, `*.repository.test.ts`) spin up real Postgres and Redis via Testcontainers — Docker must be running.

## Architecture Notes

**Startup sequence** (`src/main.ts`):
```
validateConfig()          → reject invalid PORT at process start
assertInfraReady()        → probe Postgres + both Redis instances; process.exit(1) on failure
buildApp()                → register plugins, wire modules, start BullMQ workers
app.listen()              → accept traffic
```
Any failure before `app.listen` exits the process — this is intentional. Nothing degrades silently.

**Two Redis instances** — session cache and BullMQ queue are intentionally separate:
- `REDIS_URL` — session cache. Eviction policy `allkeys-lru` is fine. Session loss is a logout, not data loss.
- `QUEUE_REDIS_URL` — BullMQ queue + idempotency key store. Must be AOF-persisted. A restart that loses this queue loses enqueued jobs.

**`AppOverrides` — how integration tests wire up** (`src/app.ts`):
```ts
const app = await buildApp({
  databaseUrl: container.getConnectionUri(),
  redisUrl: redisContainer.getConnectionUrl(),
  queueRedisUrl: redisContainer.getConnectionUrl(),
});
```
Every integration test calls `buildApp(overrides)` with Testcontainer URLs. No environment variables are read in tests — the overrides bypass `config` entirely. This means tests never need a `.env.local` and run in parallel safely.

**Two API surfaces:**
- `/platform/*` — superadmin only. Restricted by IP allowlist (`PLATFORM_IP_ALLOWLIST`). Swagger at `/platform/docs`, Bull Board at `/platform/queues`. Both return 404 to non-allowlisted IPs.
- All other routes — tenant-scoped. Authenticated via `Bearer <token>` (opaque session token, not JWT), cached in session Redis.

## Folder Map

```
src/
  modules/<domain>/   → see src/modules/CLAUDE.md (loaded when touched)
  shared/db/          → see src/shared/db/CLAUDE.md (loaded when touched)
  shared/             → tenancy, auth, cache, queue, errors, logging, config
  workers/            → BullMQ workers (separate process)
.claude/
  skills/             → on-demand playbooks
  commands/           → /pr-checklist, /adr, etc.
  settings.json       → hooks (enforcement)
docs/
  engineering-charter.md → long-form spec (read when needed)
  adr/                → architecture decisions
learnings/            → owner's personal reference only — DO NOT read or process
prisma/               → schema + migrations
```

## learnings/

This folder contains markdown files written as the owner's personal quick-reference notes. They are **not inputs for Claude**. Do not read, reference, or process any file in `learnings/` unless the owner explicitly asks you to look at a specific file for a specific reason. Code comments and commit messages may link to files inside it as breadcrumbs for human readers — those links are not an invitation to open the targets.

## Always-On Hard Rules

These apply everywhere. Violating any of them blocks a PR.

1. **`PrismaClient` is never imported outside `src/shared/db/`.** Use Kysely for every runtime query.
2. **Every business-table query passes `tenantId` explicitly.** No implicit `AsyncLocalStorage` reads inside repositories.
3. **Money is `Decimal` (`decimal.js`), stored as `numeric(19,4)`.** Never `number`. Lint rule catches it.
4. **Layered responsibility holds:** routes validate (Zod), services orchestrate, repositories query. Services don't import Fastify; repositories don't import Zod.
5. **No `console.log`, no `process.env` outside `shared/config`.** Use Pino, use the typed config object.
6. **Transactions are owned by services**, passed down to repositories as executors.
7. **State-changing endpoints write an audit row in the same transaction** as the change.
8. **Idempotency is required**: HTTP mutations honor `Idempotency-Key`; BullMQ jobs use deterministic `jobId`s.
9. **TDD applies**: failing test before implementation. Every bug fix starts with a regression test. No mocking the DB — use Testcontainers.
10. **Tenant isolation is a P0 security bug, not a style issue.** A missing `tenant_id` filter is treated as a vulnerability.

## Environment Files

- **`.env.local`** is the only env file used in development. Copy `.env.local.example` to get started.
- **`.env` is never used.** Do not create, reference, or load it. Production env vars are injected by the deployment platform.
- **No `dotenv` package.** Node 24 loads `.env.local` natively via `--env-file-if-exists=.env.local` (already in the `dev` script). All `db:*` scripts use the same flag to pass env to the Prisma CLI. Never add a `dotenv` import to application code.

## What to Reject on Sight

- `number` for money / price / cost / balance.
- Cross-module imports of internals (use the module's `index.ts` or events).
- Raw SQL strings outside `repository.ts`.
- `Math.random()` for IDs (use UUID v7) or `Date.now()` in business logic (inject a clock).
- `async` without `await`, `.catch(() => {})` with no logging, boolean parameters that switch behavior.
- Comments explaining *what* the code does. Rename or refactor instead.

## When to Load What

- Touching `src/modules/...` → `src/modules/CLAUDE.md` auto-loads. Read it.
- Touching `src/shared/db/...` → `src/shared/db/CLAUDE.md` auto-loads. Read it.
- Scaffolding a new module → `.claude/skills/scaffold-module/SKILL.md`.
- Writing a migration → `.claude/skills/add-migration/SKILL.md`.
- Adding a background job → `.claude/skills/add-bullmq-job/SKILL.md`.
- Writing a query → `.claude/skills/tenant-scoped-query/SKILL.md`.
- Need depth on something (SOLID specifics, error hierarchy, observability, caching strategy, performance budgets, security) → `docs/engineering-charter.md`.

## Git

Invoke `.claude/skills/git/SKILL.md` before any git operation — commit, push, rebase, amend, PR, recovery.

**Unconditional rules (apply even without invoking the skill):**

- **No `Co-Authored-By` trailers**, no AI attribution, no mention of Claude or any assistant tool — ever. Enforced by `.claude/hooks/block-ai-attribution.sh`; commits containing such trailers will be rejected before they land.
- **Commit or push only when the user explicitly asks.** Never on your own initiative.
- **If on the default branch (`production`), branch first** and get the new branch name confirmed before any state-mutating work.

Everything else — message style, granularity, splitting a dirty tree, rebases, push safety, PR bodies, recovery — see the git skill.

## Interaction Protocol

1. **Restate the task in one line.** Surface ambiguity. Ask before guessing.
2. **Propose the touch list** (files, interfaces, tests) before non-trivial changes.
3. **Failing test first.** Show it failing for the right reason. Then minimum implementation. Then refactor.
4. **Don't expand scope.** A bug-fix PR is not a refactor.
5. **Match existing patterns** in this codebase over external conventions.
6. **Don't invent library behavior.** If unsure how Kysely / Fastify / BullMQ behaves, say so and check the docs.
7. **If a request conflicts with this file, say so.** Don't comply silently.
8. **After any bootstrap or scaffold task**, verify every package in the Stack table above is present in `package.json` before committing. A commit message claiming a package is included is not proof it was installed.

## Forward Watch

These will trigger ADRs when adopted — track, don't preempt:

- **TypeScript 7.0** — Go-native compiler; weeks-to-months away. Run `--stableTypeOrdering` now.
- **Prisma Next / Prisma 8** — rewrite in progress; stay on 7 until 8 has adoption signal.
- **Postgres 19** — annual cadence; don't lean on cutting-edge 18 syntax unnecessarily.
