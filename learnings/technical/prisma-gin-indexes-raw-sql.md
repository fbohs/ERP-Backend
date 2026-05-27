# Prisma + GIN Indexes: Raw SQL in Migrations

## The problem

Prisma's schema DSL supports `@@index([field], type: Gin)` for simple GIN indexes on array fields. However, it **cannot express the operator class** for JSONB GIN indexes:

```prisma
// Works — Prisma handles this
@@index([tags], type: Gin)

// Does NOT work — Prisma has no syntax for operator class
@@index([specs], type: Gin)  // generates jsonb_ops (larger), cannot specify jsonb_path_ops
```

`jsonb_path_ops` is the right choice when queries use `@>` containment operators (e.g. filtering `specs @> '{"seo": {"metaTitle": "foo"}}'`). It produces a smaller, faster index than the default `jsonb_ops`. Prisma cannot express this.

## The solution: raw SQL in the migration file

Prisma migration files are plain SQL. Adding raw SQL before the migration is applied is the documented approach — not a workaround.

```sql
-- Added manually to migration.sql after prisma migrate dev --create-only
CREATE INDEX "Product_specs_gin_idx" ON "Product" USING GIN ("specs" jsonb_path_ops);
CREATE INDEX "User_specs_gin_idx"    ON "User"    USING GIN ("specs" jsonb_path_ops);
```

## Workflow

```bash
# 1. Generate without applying
npm run db:migrate -- --name <name> --create-only

# 2. Edit the generated migration.sql — add GIN index statements

# 3. Apply
npm run db:migrate:deploy
```

## Non-interactive environments (CI, Claude Code)

`prisma migrate dev` requires a TTY (`process.stdin.isTTY` check). There is no env var to bypass this. In non-interactive environments:
- Write the migration SQL manually in the correct directory
- Apply with `prisma migrate deploy` (non-interactive, no TTY needed)

The migration directory format: `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`

## How Prisma protects applied migrations

Each applied migration's SHA-256 checksum is stored in the `_prisma_migrations` table. Prisma:
- Never re-runs an applied migration
- Never overwrites migration files
- Errors loudly (checksum mismatch) if you edit a file after it's been applied

Raw SQL added BEFORE a migration is applied is safe and permanent.

## Production: use CONCURRENTLY

On tables with existing data, `CREATE INDEX CONCURRENTLY` avoids a full table lock. But it cannot run inside a transaction block — Prisma wraps migrations in transactions.

For production large-table GIN indexes, create a dedicated migration with just the `CREATE INDEX CONCURRENTLY` statement and manually remove the `BEGIN`/`COMMIT` that Prisma wraps around it, or run it outside the migration system entirely via a release script.

For dev migrations (empty tables), regular `CREATE INDEX` inside the transaction is safe and simpler.

## jsonb_path_ops vs jsonb_ops

| | `jsonb_path_ops` | `jsonb_ops` (default) |
|---|---|---|
| Supports `@>` | Yes | Yes |
| Supports `?` (key exists) | No | Yes |
| Supports `?|`, `?&` | No | Yes |
| Index size | Smaller | Larger |
| `@>` query speed | Faster | Slower |

Use `jsonb_path_ops` when queries only use `@>` containment (our case — filtering by specs shape).
Use `jsonb_ops` when queries also need key-existence operators (`?`, `?|`, `?&`).
