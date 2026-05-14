# /pr-checklist

Run the pre-PR review checklist against the current branch.

## What to do

1. Run `git diff main...HEAD --stat` and identify the touched modules.
2. For each touched file, check the items below. Don't paste the checklist back — **report only what fails**, with the file and line.
3. End with a single-line verdict: ✅ ready to push, or ❌ <count> issues to fix.

## Checklist

### Type & boundary safety
- [ ] No `any`. No `as` casts without an explanatory comment.
- [ ] No `PrismaClient` imports outside `src/shared/db/`.
- [ ] No cross-module imports of internals (only from `<module>/index.ts`).
- [ ] No `process.env` outside `src/shared/config/`.

### Tenancy & money
- [ ] Every new query filters by `tenant_id` (first filter, explicit `tenantId` parameter).
- [ ] No `number` typed `amount`/`price`/`cost`/`balance`. `Decimal` only.

### Layering
- [ ] Routes don't contain business logic or DB calls.
- [ ] Services don't import Fastify types.
- [ ] Repositories have no business `if` branches.
- [ ] Transactions originate in services, repos accept executors.

### Errors & logging
- [ ] No thrown strings, no plain `Error`. Typed `AppError` subclasses only.
- [ ] No `console.log`. Pino `log.*` only.
- [ ] Caught errors preserve `cause`; no swallowed `.catch(() => {})`.

### Audit & idempotency
- [ ] State-changing endpoints write an audit row in the same transaction.
- [ ] BullMQ jobs have deterministic `jobId` and/or state-check idempotency.
- [ ] Cross-boundary writes go through the outbox table.

### Tests
- [ ] A failing test preceded the implementation (visible in commit history).
- [ ] Integration tests use Testcontainers, not mocked DB.
- [ ] At least one cross-tenant test on new repository methods.
- [ ] `Date.now()` / `new Date()` doesn't appear in business logic — clock injected.

### DB / migrations
- [ ] Migrations are forward-only and reviewed for lock impact.
- [ ] New filterable columns have matching indexes in the same migration.
- [ ] Kysely types regenerated and committed (`generated-types.ts`).

### Hygiene
- [ ] No `Math.random()` for IDs. UUID v7 only.
- [ ] No boolean "mode" parameters switching behavior.
- [ ] No `utils.ts` / `helpers.ts` / `misc.ts` folders.
- [ ] Comments explain *why*, not *what*.

### Public surface
- [ ] Any HTTP contract change has a changelog entry and a version bump if breaking.
- [ ] New module is registered in `server.ts`.
- [ ] Module's `index.ts` exposes only the intended public surface.

## Output Format

```
<file:line> — <short reason>
<file:line> — <short reason>
...

❌ 3 issues to fix.
```

Or:

```
✅ ready to push.
```
