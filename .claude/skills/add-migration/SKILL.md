---
name: add-migration
description: Use when changing the PostgreSQL database schema — adding tables, columns, indexes, constraints, foreign keys, or backfilling data. Triggered by phrases like "add a column", "create a table", "change the schema", "new field on X", or any database structure change. Covers Prisma migration creation, manual SQL editing, Kysely type regeneration, and lock-impact review.
---

# Add a Prisma Migration

> Use when changing the database schema: adding tables, columns, indexes, constraints, or backfilling data. Triggered by "add a column", "create a table", "change the schema", or any DB structure change.

## Before You Edit `schema.prisma`

Answer these out loud first:

1. **Is the change backwards-compatible with the currently-deployed app version?** If not, plan a two-step migration (additive first, switch reads, drop later).
2. **Will the migration lock a hot table?** `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` on Postgres rewrites the table in older versions; check the column type and table size.
3. **Does this need an index?** Anything that will be filtered or joined on at scale gets an index in the same migration.
4. **Does the table need tenant scoping?** Every business table has `tenant_id uuid not null` and indexes that lead with it.
5. **Money columns?** `numeric(19,4) not null`. Time columns? `timestamptz not null`. IDs? `uuid` (default `gen_random_uuid()` or UUID v7 at the app layer).

## Workflow

### 1. Edit `prisma/schema.prisma`

Make the model change. Conventions:
- Snake_case in DB, `@@map` and `@map` for camelCase TS access where helpful.
- Every business table: `tenant_id`, `created_at`, `updated_at`, `version` (for optimistic locking).
- Foreign keys explicit, with `onDelete` chosen deliberately (usually `Restrict`).

### 2. Generate the migration

```bash
npx prisma migrate dev --name <short_imperative_description>
# e.g. add_invoices_voided_at, create_audit_log_table
```

Review the generated SQL **before** committing. If Prisma generated anything surprising (table rewrites, missing indexes, wrong defaults), edit the SQL by hand — Prisma migrations are SQL files in `prisma/migrations/`, and editing them before they're applied to production is normal.

### 3. Regenerate Kysely types

```bash
npx kysely-codegen --out-file src/shared/db/generated-types.ts
```

This must run after every migration. CI fails if `generated-types.ts` is stale.

### 4. Add the matching index migration if not auto-generated

If you added a column the app will filter by, add the index in the **same** migration file — not a separate one. Reviewers should see them together.

### 5. Tests

- Repository tests touch the new columns: write at least one read and one write test against Testcontainers.
- If the migration backfills data, add a test that asserts the backfill behavior using a fresh container.

## Hard Rules

- **Forward-only.** No `down` migrations in production. A rollback is a new forward migration.
- **Migrations run in a release step**, never on app boot.
- **No raw `prisma db push`** outside local dev experiments. Always use `migrate dev` / `migrate deploy`.
- **Concurrent indexes** (`CREATE INDEX CONCURRENTLY`) for large tables — note that Prisma's wrapping in a transaction will conflict; the generated migration may need manual editing to remove `BEGIN`/`COMMIT`.
- **Backfills** of more than a few thousand rows: separate migration, run as a BullMQ job in batches, not in the migration step.

## Review Checklist

- [ ] Backwards-compatible with the deployed app (or two-step migration documented).
- [ ] `tenant_id` present on all business tables, leading the relevant indexes.
- [ ] Money is `numeric(19,4)`, time is `timestamptz`.
- [ ] Indexes added for new filterable/joinable columns.
- [ ] Kysely types regenerated and committed.
- [ ] Tests touch the new columns.
- [ ] No silent table rewrite on a hot table.
