# Engineering Charter — ERP Backend

> Long-form reference. Not loaded automatically. Claude reads this when going deep on a topic (SOLID specifics, error hierarchy details, observability, caching, performance, security). Humans read it during onboarding.

The terse always-on rules live in the root `CLAUDE.md`. This document explains the **why** and provides the **how** at depth.

---

## Table of Contents

1. [Operating Principles](#operating-principles)
2. [SOLID — Project-Specific Application](#solid)
3. [The Prisma + Kysely Contract (Deep Dive)](#kysely-contract)
4. [Multi-Tenancy](#multi-tenancy)
5. [Validation](#validation)
6. [Errors](#errors)
7. [Authentication & Authorization](#auth)
8. [Audit Logging](#audit)
9. [Caching](#caching)
10. [BullMQ & the Outbox Pattern](#bullmq)
11. [Concurrency & Consistency](#concurrency)
12. [Testing — With Teeth](#testing)
13. [Logging & Observability](#observability)
14. [Performance](#performance)
15. [Security](#security)
16. [Configuration & Environments](#config)
17. [Git, Commits, Pull Requests](#git)
18. [Anti-Patterns Library](#anti-patterns)

---

## <a id="operating-principles"></a>1. Operating Principles

Priority order when trade-offs collide:

1. **Correctness over cleverness.** A boring, obviously-correct solution beats an elegant one that needs a comment to defend.
2. **Explicitness over magic.** No hidden globals, no implicit context, no "framework magic" the next engineer has to grep for.
3. **Reversibility.** Prefer changes that are easy to undo. Be especially careful with migrations, queue payloads, and public API shapes.
4. **Make the wrong thing hard.** If a footgun exists (e.g., a money field typed as `number`), fix the type system, not the developers.

---

## <a id="solid"></a>2. SOLID — Project-Specific Application

Generic SOLID slogans are useless. Concretely:

- **SRP** — Each service method maps to **one business capability** (e.g. `invoiceService.markAsPaid`). If a method takes a `mode` boolean to switch behavior, split it.
- **OCP** — New payment providers, tax rules, or document templates plug in via **strategy interfaces** under `shared/` or the module's `types.ts`. Do not edit a `switch` statement; register a new strategy.
- **LSP** — Repository interfaces must be substitutable for tests. If a fake repo can't satisfy the type, the type is leaking implementation (Kysely query builders out, plain return types in).
- **ISP** — Services depend on **narrow interfaces** like `InvoiceReader` and `InvoiceWriter`, not on the whole `InvoiceRepository`. This keeps test doubles small.
- **DIP** — Wire concrete implementations only in `server.ts` / DI container. Inner layers depend on interfaces from `<domain>.types.ts`.

---

## <a id="kysely-contract"></a>3. The Prisma + Kysely Contract (Deep Dive)

The terse version lives in `src/shared/db/CLAUDE.md`. Here are the things that don't fit there.

### Why this split exists

Prisma's developer experience for schemas and migrations is excellent. Its runtime client, however, has a history of generating expensive queries, struggles with complex joins, and (in versions ≤6) shipped a Rust binary that added operational weight. Prisma 7 dropped the Rust engine in favor of a WASM module on the main thread — a good move, but it also means the internal type contract that bridge packages (`prisma-extension-kysely`, `kysely-prisma-types`) depended on is in flux.

Kysely, by contrast, is a thin, type-safe SQL builder with no runtime magic. We use it for every runtime query and generate its `DB` type directly from the live database via `kysely-codegen`. That keeps Prisma's contribution scoped to where it shines (schema + migrations) and gives us full SQL control everywhere else.

### When `sql\`\`` is acceptable

Almost never. Cases where it's defensible:
- Postgres-specific window functions Kysely doesn't yet model.
- `ON CONFLICT ... DO UPDATE` with complex expressions (Kysely supports the simple cases natively).
- Recursive CTEs with self-references.

Whenever you reach for it, leave a comment naming the Kysely limitation and parameterize every input.

---

## <a id="multi-tenancy"></a>4. Multi-Tenancy

Every business table has a `tenant_id` column. Every query filters by it. The terse version is in the root `CLAUDE.md`; here's the depth.

**Tenant context flow:**
1. Auth middleware looks up the Bearer token and populates `request.user` with `{ userId, tenantId, role }`.
2. The route handler reads `request.user.tenantId` and passes it **explicitly** to the service.
3. The service passes `tenantId` **explicitly** to every repository call.
4. Repositories never derive tenant context on their own — `tenantId` is always a parameter.

The explicit-parameter rule exists because (a) it makes repositories testable without any request context, and (b) non-HTTP entry points (scripts, CLI tools, BullMQ jobs) would have no middleware to set implicit context — relying on it would produce a silent cross-tenant leak. Explicit parameters fail loudly when the value is missing.

**Admin tooling** that genuinely needs to cross tenants uses a clearly named API surface (`dbAcrossTenants`, not `db`). Reviewers should treat any use of it like a security-sensitive code path.

---

## <a id="validation"></a>5. Validation

Zod, at the boundary, once.

- **Schemas live in `<domain>.schemas.ts`.** Each endpoint has a request and response schema; reuse via composition.
- **Parse with `.parse()` in routes.** Downstream layers receive validated, narrowed types.
- **Coerce at the boundary** (`z.coerce.date()` for query strings), never deeper.
- **No double-parsing.** It's wasted CPU and doubles the error surface.

---

## <a id="errors"></a>6. Errors

```ts
// shared/errors/base.ts
export abstract class AppError extends Error {
  abstract readonly code: string;     // stable machine code
  abstract readonly statusCode: number;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

export class NotFoundError extends AppError { code = 'NOT_FOUND'; statusCode = 404; }
export class ValidationError extends AppError { code = 'VALIDATION'; statusCode = 400; }
export class ConflictError extends AppError { code = 'CONFLICT'; statusCode = 409; }
export class ForbiddenError extends AppError { code = 'FORBIDDEN'; statusCode = 403; }
export class UnauthorizedError extends AppError { code = 'UNAUTHORIZED'; statusCode = 401; }
export class DomainError extends AppError { /* 422 */ statusCode = 422; }
export class IntegrationError extends AppError { /* 502 */ statusCode = 502; }
```

Modules subclass these (`InvoiceNotFoundError extends NotFoundError`). The global Fastify error handler maps `AppError` → wire format, `ZodError` → 400 with field details, everything else → generic 500 with stack logged. Every response carries `x-request-id`.

---

## <a id="auth"></a>7. Authentication & Authorization

- **Authn:** Opaque session tokens stored in the `Session` table and cached in Redis with an absolute TTL. No JWT. On each request the token is looked up in Redis (fast path) or Postgres (slow path); the resulting `{ userId, tenantId, role }` is placed on `request.user`. Tokens are not rotated — they expire absolutely and are deleted on logout.
- **Authz:** RBAC declared on routes via a `preHandler`:

  ```ts
  fastify.post('/invoices/:id/void', {
    preHandler: [authenticate, authorize('invoice:void')],
    schema: { ... },
  }, handler);
  ```

- Authorization is never decided inside services for HTTP entry points.
- Background jobs run under a system principal with scoped permissions, never "admin-everything."
- Sensitive operations (delete, void, refund) require an approval workflow, not a UI confirmation.

---

## <a id="audit"></a>8. Audit Logging

Schema: `audit_log(id, tenant_id, actor_id, entity_type, entity_id, action, before, after, request_id, occurred_at)`.

- Implemented as a service decorator or post-commit hook, not littered across handlers.
- `before`/`after` are JSONB; sensitive fields redacted before storage.
- Audit writes share the transaction with the operation. If the operation rolls back, the audit row does too.
- Mirror to a tamper-resistant store (append-only, separate credentials) asynchronously.

---

## <a id="caching"></a>9. Caching

- Cache reads, not writes.
- Every key includes the tenant: `tenant:{id}:invoice:{id}`.
- Every value has an explicit TTL.
- Invalidation lives next to the write path. Define `invalidate*` per entity; call from every writer.
- Read-through helper:

  ```ts
  await cache.get(`tenant:${t}:invoice:${id}`, { ttl: 300 }, () => repo.findById(t, id));
  ```

- Don't cache derived calculations across requests without versioning the inputs. Stale numbers in an ERP are worse than a slow page.

---

## <a id="bullmq"></a>10. BullMQ & the Outbox Pattern

See `.claude/skills/add-bullmq-job/SKILL.md` for the workflow. Depth points:

**Workers in a separate process.** This is non-negotiable. Queue backpressure inside the HTTP process kills request latency under load.

**The outbox table** is the bridge between DB writes and queue dispatches:

```sql
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',  -- pending | dispatched | failed
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE status = 'pending';
```

A relay worker reads pending rows, enqueues to BullMQ, marks `dispatched`. This eliminates "DB committed but enqueue failed" failure modes. The relay is itself idempotent — if it crashes mid-batch, it retries; BullMQ dedupes on `jobId`.

---

## <a id="concurrency"></a>11. Concurrency & Consistency

- **Optimistic locking** via `version` column on every editable business entity. `UPDATE ... WHERE id=? AND version=?` then bump version. Zero-row update → `ConflictError`.
- **Pessimistic locking** (`SELECT ... FOR UPDATE`) only inside short transactions, only where serialization is genuinely required (inventory decrement under contention is the canonical case).
- **Keyset pagination** on large tables. Offset pagination only when result sets are bounded < 10k.

---

## <a id="testing"></a>12. Testing — With Teeth

The pyramid:
1. **Unit** (`*.service.test.ts`) — pure logic with fake repositories. <10ms each. Run on save.
2. **Integration** (`*.repository.test.ts`, `*.routes.test.ts`) — real Postgres + real Redis via Testcontainers. Parallel-safe DBs per file.
3. **End-to-end** (`tests/e2e/`) — full HTTP flows across modules. Sparingly: happy paths + one or two failure modes per flow.

**Rules:**
- **Red → Green → Refactor.** Show the failing test for the right reason before the implementation.
- **No mocking the DB.** Mocked ORM calls produce tests that pass while production breaks.
- **No mocking time.** Inject a `clock` dependency. Tests pass a fake clock.
- **Factories, not fixtures.** `makeInvoice(overrides)` beats JSON files. Seed `faker` for reproducibility.
- **Mutation score** ≥ 70% on critical modules (`accounting`, `billing`).
- **Every bug fix begins with a failing regression test.**
- Tests are deterministic and parallel-safe. No shared global state, no ordering dependencies.

---

## <a id="observability"></a>13. Logging & Observability

- Pino with structured fields. Required on every log line: `requestId`, `tenantId`, `actorId`, `module`.
- Levels: `error` (action required), `warn` (anomaly, no action), `info` (state changes), `debug` (dev only).
- **Never log secrets, PII, or full payloads** without redaction. Maintain redaction config in `shared/logging`.
- Metrics via OpenTelemetry: request latency (p50/p95/p99), DB query latency, queue depth per BullMQ queue, cache hit ratio.
- Traces span HTTP → service → DB → queue. Propagate `traceparent`.
- Health: `/healthz` (process up), `/readyz` (DB + Redis reachable). Workers expose their own.

---

## <a id="performance"></a>14. Performance

- List endpoints paginate; default limit ≤ 50, max ≤ 200.
- Queries touching > 10k rows have a matching index. Migration ships with it.
- N+1 detection in dev and CI. Failing N+1 fails the build.
- Budgets: p95 < 300ms read, < 800ms write. Job p95 < 5s for synchronous-feeling jobs.
- Load tests (k6 or similar) for endpoints expected to exceed 100 RPS, before they ship.

---

## <a id="security"></a>15. Security

- Secrets via env vars, parsed through Zod config at startup. Missing required var → crash, no fallback defaults.
- `npm audit --omit=dev` (or Snyk equivalent) in CI. Critical CVEs block deploys.
- All external input validated (Zod), all output encoded for destination, logs redacted.
- Per-IP and per-tenant rate limiting on auth endpoints. Account lockout after N failed attempts.
- CORS allowlist explicit per environment.
- API uses bearer tokens (no cookies) for browser clients → no CSRF surface.
- File uploads: scanned, type-sniffed (not `Content-Type`), size-limited, served via signed URLs.

---

## <a id="config"></a>16. Configuration & Environments

- One `config` object, typed, parsed at boot. `process.env` is banned outside `shared/config/` by lint rule.
- Environments: `development`, `test`, `staging`, `production`.
- Feature flags via a typed flag service.
- Migrations run in a release step, not on app boot.

---

## <a id="git"></a>17. Git, Commits, Pull Requests

- Branches: `feat/<scope>-<desc>`, `fix/<scope>-<desc>`, `chore/...`, `refactor/...`.
- Commits: Conventional Commits, imperative mood. Body explains *why*, not *what*.
- PRs:
  - One reviewer minimum; two for migrations or `shared/`.
  - Description: problem, approach, alternatives considered, rollout/rollback plan.
  - CI green: lint, type-check, unit, integration, migration dry-run.
- No force-push to `main`. Squash-merge feature branches; `main` stays linear.

---

## <a id="anti-patterns"></a>18. Anti-Patterns Library

The terse list lives in root `CLAUDE.md`. Full library:

1. `PrismaClient` imported outside `shared/db/`.
2. `number` for money.
3. Service methods returning Kysely query builders.
4. Repositories with `if` branches encoding business rules.
5. Cross-module imports of internals.
6. Catching errors only to re-throw a generic one (loses `cause`).
7. `async` functions without `await` inside.
8. Boolean parameters that switch behavior.
9. "Util" / "helpers" / "misc" folders.
10. Comments explaining *what* instead of *why*.
11. `Date.now()` or `new Date()` in business logic (inject a clock).
12. `Math.random()` for IDs or business data.
13. Swallowed promise rejections (`.catch(() => {})` without logging).
14. Logging the same error at multiple levels of the call stack.
15. Schema changes without a migration, or editing migrations after merge.
16. Reading `process.env` outside `shared/config/`.
17. Reading tenant context inside repositories.
18. `SELECT *` on business tables.

---

*This document is the explanation. The root `CLAUDE.md` is the contract. When they disagree, fix the document that's wrong.*
