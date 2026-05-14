---
name: tenant-scoped-query
description: Use when writing or reviewing any Kysely query in a repository.ts file that touches business data. Triggered when adding a new repository method, writing a SELECT/INSERT/UPDATE/DELETE on a business table, adding pagination, writing joins across business tables, or implementing optimistic locking. Enforces tenant_id filtering on every query — missing tenant scoping is a P0 security bug.
---

# Write a Tenant-Scoped Query

> Use when adding any repository method that touches business data. Triggered when writing or reviewing Kysely queries in `<domain>.repository.ts`.

## The One Rule

**Every business-table query filters by `tenant_id`.** A missing filter is a **P0 security bug** — treat it like SQL injection.

## Anatomy of a Correct Repository Method

```ts
async findInvoiceById(
  tenantId: string,
  invoiceId: string,
): Promise<Invoice | null> {
  const row = await this.exec
    .selectFrom('invoices')
    .where('tenant_id', '=', tenantId)        // ← always first, always present
    .where('id', '=', invoiceId)
    .select(['id', 'tenant_id', 'amount', 'status', 'version']) // ← no SELECT *
    .executeTakeFirst();

  return row ? mapToInvoice(row) : null;
}
```

Three things to notice:
1. `tenantId` is an **explicit parameter** — not read from `AsyncLocalStorage` inside the repo.
2. The `tenant_id` filter is **always present, always first**.
3. Columns are **projected explicitly** — no `selectAll()`.

## Inserts

`tenant_id` is set from the parameter, never optional, never defaulted:

```ts
async insertInvoice(tenantId: string, data: NewInvoice): Promise<string> {
  const id = uuidv7();
  await this.exec
    .insertInto('invoices')
    .values({
      id,
      tenant_id: tenantId,
      amount: data.amount.toString(),  // Decimal → string for numeric column
      status: 'draft',
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return id;
}
```

## Updates with Optimistic Locking

```ts
async markInvoicePaid(
  tenantId: string,
  invoiceId: string,
  expectedVersion: number,
): Promise<void> {
  const result = await this.exec
    .updateTable('invoices')
    .set({ status: 'paid', version: expectedVersion + 1, updated_at: new Date() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .where('version', '=', expectedVersion)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new ConflictError('Invoice was modified by another writer');
  }
}
```

## Lists with Pagination

Keyset pagination on large tables:

```ts
async listInvoices(
  tenantId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ rows: Invoice[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit, 200); // server-enforced max

  let q = this.exec
    .selectFrom('invoices')
    .where('tenant_id', '=', tenantId)
    .select(['id', 'tenant_id', 'amount', 'status', 'version', 'created_at'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc') // tiebreaker for stability
    .limit(limit + 1);

  if (opts.cursor) {
    const { createdAt, id } = decodeCursor(opts.cursor);
    q = q.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', id)]),
      ]),
    );
  }

  const rows = await q.execute();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;
  return { rows: page.map(mapToInvoice), nextCursor };
}
```

Offset pagination is **only** allowed when result sets are guaranteed < 10k rows.

## Joins Across Business Tables

Every joined business table needs its own `tenant_id` filter — defense in depth, in case one filter is missed during refactor:

```ts
await this.exec
  .selectFrom('invoices as i')
  .innerJoin('customers as c', (j) =>
    j.onRef('c.id', '=', 'i.customer_id').on('c.tenant_id', '=', tenantId),
  )
  .where('i.tenant_id', '=', tenantId)
  .select(['i.id', 'i.amount', 'c.name'])
  .execute();
```

## Forbidden

- Reading tenant from `AsyncLocalStorage` inside a repository method.
- `selectAll()` on business tables.
- `LIMIT` without a stable `ORDER BY`.
- Looping over IDs and querying inside the loop (N+1).
- Raw SQL strings unless Kysely's typed builders genuinely can't express the query — and even then, leave a comment explaining why and parameterize all inputs.
- Touching `number` for money. Use `Decimal` ↔ string at the DB boundary.

## Tests

Every new query gets an integration test against Testcontainers Postgres:
- Happy path returns expected rows.
- **Cross-tenant test**: insert rows for tenant A and tenant B, query as tenant A, assert tenant B's rows are not returned. This is the single most important test in the codebase.

## Checklist

- [ ] `tenant_id` filter present (and first).
- [ ] `tenantId` is an explicit parameter, not from context.
- [ ] Columns projected explicitly (no `selectAll`).
- [ ] Money uses `Decimal` ↔ string mapping.
- [ ] Mutations on optimistically-locked entities use `version`.
- [ ] List queries paginate with a stable sort.
- [ ] Joins re-apply `tenant_id` on each business table.
- [ ] Cross-tenant integration test added.
