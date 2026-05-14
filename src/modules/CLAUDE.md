# CLAUDE.md — `src/modules/`

> Auto-loads when working inside any module. Module-level rules only.

## Module Structure

```
<domain>/
  <domain>.routes.ts          Fastify routes only
  <domain>.controller.ts      Optional thin layer when routes get noisy
  <domain>.service.ts         Business logic; orchestrates repos + integrations
  <domain>.repository.ts      Pure Kysely queries. Tenant-scoped, parameterized.
  <domain>.schemas.ts         Zod schemas (request/response/domain)
  <domain>.errors.ts          Domain-specific error subclasses
  <domain>.types.ts           Domain types not derived from DB
  index.ts                    Public surface (re-exports only what other modules can use)
  jobs/                       BullMQ processors + queue definitions
  events/                     Domain events (cross-module communication)
  __tests__/                  Unit + integration tests for this module
```

## Layer Rules

| Layer       | Allowed                                                 | Forbidden                                                 |
| ----------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Route       | Zod validation, call service, shape response, set status | Business logic, DB calls, calling other services directly |
| Service     | Business rules, orchestration, transaction boundaries   | `req`/`reply`, raw SQL, Zod parsing of HTTP payloads      |
| Repository  | Kysely queries, mapping rows to domain types            | `if` branches encoding business rules, throwing HTTP errors |

**Smells (flag in review):**
- Repository method named `getXAndDoY` → that's a service.
- Service constructing `db.selectFrom(...)` → the repo is missing a method.
- Route doing math or branching on business state → move to service.

## Cross-Module Communication

- **Allowed:** importing from another module's `index.ts` (its published surface).
- **Allowed:** publishing/subscribing to domain events.
- **Forbidden:** reaching into another module's `repository.ts`, `service.ts` internals.
- If you find yourself wanting to, stop and propose an ADR via `/adr`.

## Tenant Scoping

Every business-table query in this module takes `tenantId` as an explicit parameter. Repositories do **not** read tenant context implicitly — that's the service's job. Missing scoping is a P0 security bug.

## Errors

Module defines its own subclasses extending `shared/errors/base.ts`:

```ts
// invoice.errors.ts
import { NotFoundError, ConflictError } from '@/shared/errors/base';
export class InvoiceNotFoundError extends NotFoundError { readonly code = 'INVOICE_NOT_FOUND'; }
export class InvoiceAlreadyVoidedError extends ConflictError { readonly code = 'INVOICE_ALREADY_VOIDED'; }
```

Never throw strings or plain `Error`. The global handler in `shared/errors/handler.ts` shapes the wire format.

## Tests for This Module

- Unit tests with fake repositories live in `__tests__/<domain>.service.test.ts`.
- Integration tests against real Postgres (Testcontainers) live in `__tests__/<domain>.repository.test.ts` and `__tests__/<domain>.routes.test.ts`.
- Factories live in `__tests__/factories.ts`. No JSON fixture files.
- Every method in the service has at least one happy-path test and one failure-mode test.

For full testing depth: `docs/engineering-charter.md#testing`.
