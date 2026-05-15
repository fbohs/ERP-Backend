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

**Package versions are always exact.** No `^` or `~` in `package.json`. Use `npm install --save-exact` / `npm install --save-dev --save-exact`.

**After adding packages, audit for unused ones.** Grep `src/` for imports of every existing package. Remove anything with zero imports that is not a locked stack dependency (stack deps like `bullmq`, `decimal.js` are retained even if not yet used — they will be). Use `npm uninstall` to remove from both `package.json` and `node_modules`.

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
learnings/            → shared engineering notes — technical references & feature write-ups (safe to read)
prisma/               → schema + migrations
project-learnings/    → owner's personal reference only — DO NOT read or process
```

## project-learnings/

This folder contains markdown files written as the owner's personal quick-reference notes. They are **not inputs for Claude**. Do not read, reference, or process any file in `project-learnings/` unless the owner explicitly asks you to look at a specific file for a specific reason.

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

## Commit Messages

- Write commit messages as plain engineering summaries.
- **No `Co-Authored-By` trailers**, no AI attribution, no mention of Claude or any assistant tool — ever.

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
