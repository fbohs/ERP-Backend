# CLAUDE.md — `src/shared/db/`

> Auto-loads when touching DB layer. Prisma + Kysely contract is the entire reason this file exists.

## Roles

- **Prisma 7** owns `schema.prisma`, `prisma.config.ts`, migrations. Nothing else.
- **`kysely-codegen`** generates the `DB` interface — **from the live database**, not from Prisma's client. Runs in CI after every migration.
- **Kysely** is the only runtime query interface. Period.
- `PrismaClient` is only imported inside this directory, and only for migration tooling.

> **Why generate from the DB, not from Prisma?** Prisma 7 replaced the Rust query engine with a WASM module on the JS main thread. Bridges that translated Prisma's internal types to Kysely are fragile under the rewrite. The database is the source of truth — introspect it directly.

## Kysely Instance

```ts
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './generated-types'; // from kysely-codegen

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
    }),
  }),
  log: ['error'], // 'query' in dev only
});
```

## Transactions

**Service owns the transaction. Repositories accept executors.**

```ts
// repository pattern
export class InvoiceRepository {
  constructor(private exec: Kysely<DB> | Transaction<DB>) {}
  withTx(tx: Transaction<DB>) { return new InvoiceRepository(tx); }
}

// service pattern
await db.transaction().execute(async (tx) => {
  const invoices = this.invoiceRepo.withTx(tx);
  const ledger = this.ledgerRepo.withTx(tx);
  // multi-repo work inside one transaction
});
```

**Rules:**
- One transaction per business operation. No nesting without savepoints.
- Never enqueue BullMQ jobs or call external APIs inside a transaction. Use the **outbox pattern** (see `engineering-charter.md#outbox`).
- Reads needing consistency with a write share the same transaction.

## Hard Rules

1. **Tenant scope every query** touching a business table. `tenantId` is an explicit parameter.
2. **No `SELECT *`.** Project exactly the columns needed.
3. **No raw SQL strings outside `repository.ts`.** Kysely's typed builders cover almost everything; if `sql\`\`` is genuinely needed, leave a comment explaining why.
4. **No N+1 loops.** Use `inArray`, joins, or window functions.
5. **Money: `numeric(19,4)` ↔ `Decimal` (`decimal.js`)**, never `number`.
6. **Time: `timestamptz` ↔ `Date`**, serialized as ISO-8601 UTC at boundaries.
7. **IDs: UUID v7** for new entities. No auto-increment integers on business tables.
8. **Optimistic locking:** business entities have a `version` column. Updates filter `WHERE id = ? AND version = ?` and bump it. A 0-row update raises `ConflictError`.

## Connection Pool Note

Prisma 7's WASM query compiler runs on the main thread. Migration tooling competes with the HTTP event loop. Therefore:
- Migrations run as a **release step**, not on app boot.
- Forward-only migrations. Rollback is a new forward migration.
- Pool size is tuned against Kysely's actual concurrency, not Prisma defaults.
