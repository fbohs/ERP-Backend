---
name: scaffold-module
description: Use when adding a new top-level domain module under src/modules/ (e.g., accounting, hr, inventory, billing). Triggered when the user asks to create a new module, add a new domain, scaffold a feature area, or set up the folder layout for a new business capability. Do NOT use when adding a feature to an existing module — use a different workflow for that.
---

# Scaffold a New Domain Module

> Use this skill when adding a new module under `src/modules/` (e.g., `accounting`, `hr`, `inventory`, `billing`). Triggered when the user asks to "create a new module", "add a domain", or scaffold any new feature area.

## When This Applies

The request involves creating a new top-level domain folder under `src/modules/`. Not for adding a feature to an existing module — that uses `add-endpoint` flow instead.

## Steps

### 1. Confirm scope

Before creating anything, restate:
- What is the domain noun? (e.g. `invoicing`, not `invoices-service`)
- What entities does it own? (list the Prisma models that will live here)
- Does it overlap with an existing module? If yes, **stop** — propose merging or boundary clarification via `/adr`.

### 2. Create the folder skeleton

```
src/modules/<domain>/
  <domain>.routes.ts
  <domain>.service.ts
  <domain>.repository.ts
  <domain>.schemas.ts
  <domain>.errors.ts
  <domain>.types.ts
  index.ts
  __tests__/
    factories.ts
    <domain>.service.test.ts
    <domain>.repository.test.ts
    <domain>.routes.test.ts
```

`jobs/` and `events/` are added only when actually needed — don't create empty directories.

### 3. File templates

Each file starts with the minimum that compiles, not a "TODO" comment. Examples:

**`<domain>.errors.ts`**
```ts
import { NotFoundError } from '@/shared/errors/base';
export class <Domain>NotFoundError extends NotFoundError {
  readonly code = '<DOMAIN>_NOT_FOUND';
}
```

**`<domain>.repository.ts`** — accepts `Kysely<DB> | Transaction<DB>` via constructor, exposes `withTx`. Every method takes `tenantId` as the first parameter.

**`<domain>.service.ts`** — depends on repository interface from `<domain>.types.ts`, not the concrete class. Methods are named after business capabilities (`markInvoicePaid`, not `updateInvoiceWithMode`).

**`<domain>.routes.ts`** — registers as a Fastify plugin. Routes call the service; routes do not touch the DB.

**`index.ts`** — re-exports only what other modules may consume (typically a service interface and select types). **Internal files are not re-exported.**

### 4. Wire into the app

- Add a `fastify.register(<domain>Plugin, { prefix: '/<domain>' })` line in `src/server.ts`.
- If the module owns Prisma models, run `/add-migration` next.
- Add the module to the cross-module event registry only when events are actually published.

### 5. Write the first failing test

Pick the simplest business capability (usually a `getById`). Write the integration test in `<domain>.routes.test.ts` against Testcontainers Postgres. **Show the test failing before implementing.**

### 6. Implement the minimum to pass, then refactor.

## Checklist Before Marking Done

- [ ] Folder matches the structure above exactly. No extra files.
- [ ] `index.ts` exposes only the module's public surface.
- [ ] Every repository method takes `tenantId` explicitly.
- [ ] At least one failing-then-passing test exists.
- [ ] Module registered in `server.ts`.
- [ ] No cross-module imports of internals.

## What Not to Do

- Don't create `utils.ts` or `helpers.ts`. Put functions where they're called from.
- Don't create empty `jobs/` or `events/` folders speculatively.
- Don't import Fastify types in the service.
- Don't read tenant context from `AsyncLocalStorage` inside repos.
