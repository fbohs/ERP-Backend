# Runbook: DB Migration in Production

> Apply pending Prisma migrations to the production database safely.

---

## When to run

Any deployment that includes new files under `prisma/migrations/`.

---

## Steps

**1. Confirm you have a backup.**
Take a snapshot or point-in-time restore before touching the schema. Do not skip this.

**2. Check which migrations are pending:**
```bash
DATABASE_URL=<prod-url> pnpm exec prisma migrate status
```
Expected: a list of pending migrations.
If output says *"Database schema is up to date"* — stop, there is nothing to apply.

**3. Apply pending migrations:**
```bash
DATABASE_URL=<prod-url> pnpm db:migrate:deploy
```
Expected: each pending migration logged as `Applied`. Exit code 0.

Unlike `pnpm db:migrate` (dev), `migrate deploy` never prompts and never creates new migrations — it only applies what is already committed.

**4. Restart the application** so the running process reflects the new schema.

---

## What can go wrong

**Migration fails mid-way.**
Prisma wraps each migration in a transaction where possible. If a migration is not transactional (e.g. `CREATE INDEX CONCURRENTLY`), a partial failure leaves the DB in an intermediate state. Restore from backup and fix the migration before retrying.

**Lock timeout on a large table.**
`ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock. Use `CREATE INDEX CONCURRENTLY` for new indexes and add a `SET lock_timeout = '5s';` at the top of the migration SQL to fail fast rather than queue indefinitely.

**Enum changes.**
`ALTER TYPE ... ADD VALUE` cannot be rolled back inside a transaction. If you hit this, see `docs/known-issues.md`.
