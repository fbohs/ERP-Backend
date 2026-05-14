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
| PostgreSQL      | `18.4`                                         |
| Redis / Valkey  | Redis OSS `8.6.x` or Valkey `8.x` (either)     |
| BullMQ          | latest                                         |
| Zod, Pino, Vitest, Supertest, Testcontainers, ESLint, Prettier | latest stable |

Anything outside this list → ADR (`/adr`).

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
prisma/               → schema + migrations
```

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

## Interaction Protocol

1. **Restate the task in one line.** Surface ambiguity. Ask before guessing.
2. **Propose the touch list** (files, interfaces, tests) before non-trivial changes.
3. **Failing test first.** Show it failing for the right reason. Then minimum implementation. Then refactor.
4. **Don't expand scope.** A bug-fix PR is not a refactor.
5. **Match existing patterns** in this codebase over external conventions.
6. **Don't invent library behavior.** If unsure how Kysely / Fastify / BullMQ behaves, say so and check the docs.
7. **If a request conflicts with this file, say so.** Don't comply silently.

## Forward Watch

These will trigger ADRs when adopted — track, don't preempt:

- **TypeScript 7.0** — Go-native compiler; weeks-to-months away. Run `--stableTypeOrdering` now.
- **Prisma Next / Prisma 8** — rewrite in progress; stay on 7 until 8 has adoption signal.
- **Postgres 19** — annual cadence; don't lean on cutting-edge 18 syntax unnecessarily.
