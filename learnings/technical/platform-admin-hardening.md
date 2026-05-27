# Platform-admin hardening — session notes

> Captured 2026-05-26 from the superadmin-review work. Branch: `feature/auth_flow`.
> Commits: `05f6dce` → `78dc96d` → `addb0ee` → `35b02da`. ADR 0002.

## Charter vs. reality

The locked stack table named **kysely-codegen** but the repo had drifted to
**prisma-kysely**. When the charter and reality disagree, surface it loudly —
don't silently pick whichever is wired. We realigned to the charter (no ADR
needed because the charter was already the authority).

---

## Kysely type pipeline: prisma-kysely → kysely-codegen, what bit

|                    | prisma-kysely                | kysely-codegen                            |
| ------------------ | ---------------------------- | ----------------------------------------- |
| Source of truth    | `schema.prisma` (datamodel)  | the live database (introspected)          |
| Needs a live DB?   | no                           | yes (DATABASE_URL or `--url`)             |
| Enum type names    | preserved (`UserRole`)       | re-cased PascalCase-by-first-letter (`Userrole`, `Actortype`) |
| Enum representation| `const` object + type alias  | union type alias only (not a value)       |
| `Json` columns     | `unknown \| null`            | `Json \| null` (= `JsonValue`, narrower)  |
| BigInt columns     | `string` / `Generated<string>` | `Int8 = ColumnType<string, bigint\|number\|string, …>` |
| `_prisma_migrations` table | not emitted          | IS emitted as `_PrismaMigrations`         |

Reconciliation required in ~5 call sites (enum import renames + a `as Json | null`
cast on the audit `before`/`after` insert). Enum values were strings (`'ADMIN'`)
not `UserRole.ADMIN`, so dropping the `const` object cost nothing.

---

## Prisma 7 migrations in a non-interactive shell

`prisma migrate dev` **requires a TTY**. Even `--create-only` errors out with
"non-interactive not supported" when there are warnings (e.g. column drops).

Workaround to produce the SQL without applying:

```sh
node --env-file-if-exists=.env.local node_modules/prisma/build/index.js \
  migrate diff --from-config-datasource --to-schema ./prisma/schema.prisma --script
```

Then drop the SQL into `prisma/migrations/<ts>_name/migration.sql` and apply via
`migrate deploy` (non-interactive). Prisma 7 removed `--from-url` — use
`--from-config-datasource` (reads from `prisma.config.ts`).

Column **renames** in Prisma are drop+add: data is lost. Empty tables → fine;
otherwise plan a two-step migration (add new, backfill, drop old).

---

## Hashed bearer tokens at rest

SHA-256 (not argon2). Magic-link and session tokens are 32-byte CSPRNG random,
so a fast one-way hash is sufficient; argon2 would also break the
`@unique` index lookup pattern. Helper: `src/shared/auth/token-hash.ts`.

Storing only hashes means a DB leak (backup, replica, SQLi read) yields no
usable credential. Half-measures defeat themselves: if you hash in Postgres but
keep the raw token as the Redis cache key, you've not actually hidden anything.
Pair hashing with **DB-only auth** so there's no Redis copy.

Tenant `Session` / `PasswordResetToken` still store raw — same vulnerability,
deferred follow-up.

---

## DB-only auth for the platform surface

The platform operator population is tiny (handful), so the session cache buys
negligible throughput but **breaks instant revocation**. Removing it makes
logout, single-session eviction, and CLI termination effective on the very next
request.

Keep the cache on tenant auth (high traffic). The asymmetry is intentional —
revocation latency tolerance differs by surface.

---

## Atomic single-use tokens

The right primitive for a single-use magic link is

```sql
DELETE FROM "PlatformAdminLoginToken"
 WHERE "tokenHash" = $1
 RETURNING "adminId", "expiresAt";
```

The "row returned" test **is** the single-use guard. The previous pattern
(`SELECT … check usedAt, then UPDATE usedAt = now()`) has a check-then-act
window where two concurrent verifies could both pass before either committed.
Once you delete-on-use, the `usedAt` column is vestigial — drop it.

---

## Platform audit ≠ tenant audit

`AuditLog.tenantId` is **NOT NULL** by design (and every index leads with
tenantId). Platform-global events (login, logout, admin lifecycle via CLI)
have no tenant → cannot ride that table.

Solution: a separate `PlatformAuditLog` with no `tenantId`. Tenant-scoped
platform actions (tenant created/suspended) still write to `AuditLog` with
`actorType = PLATFORM_ADMIN`. Don't make `AuditLog.tenantId` nullable — it
weakens the indexed-by-tenant query story for every other use.

For CLI-originated rows the `adminId` is the **affected** admin (so "history
for admin X" stays queryable). There's no actor principal in CLI; `requestId`
being null is the marker.

---

## Enumeration-timing leaks

"Always return 200 regardless of whether the email is known" is necessary but
**not sufficient**. The branches must do equal work or timing reveals the
answer. The pattern: generate the token + open the transaction
**unconditionally**; the transaction body is the only branch (no-op for the
unknown-email case). Compare `auth.forgotPassword` — same shape.

---

## npm scripts and the `--` separator

`npm run <script> --flag` is consumed by npm itself, not forwarded. The `--`
separator is mandatory:

```sh
npm run platform:update-admin -- --email ops@example.com --name "Ops" --active true
```

Trying to drop it via `npm_config_*` env vars collides with real npm configs
(`email` is a built-in npm config key). Options: keep `--`, or ship a real
`bin` wrapper. We kept `--`.

---

## Commit splitting with multi-touch files

Generated files (`src/types/db.ts`) split across commits — don't hand-edit them.
Regenerate against a **throwaway database** at the intermediate schema state:

```sh
# 1. fresh db
docker exec -e PGPASSWORD=… postgres psql -U … -d postgres \
  -c 'CREATE DATABASE erp_codegen_old;'

# 2. apply N-1 migrations
for m in <prior migration dirs>; do
  psql -U … -d erp_codegen_old < "prisma/migrations/$m/migration.sql"
done

# 3. kysely-codegen also emits the _prisma_migrations interface, so copy that
# table's structure too or the row counts won't match the real flow:
pg_dump -t _prisma_migrations --schema-only erp_dev | psql -d erp_codegen_old

# 4. regenerate types at the prior schema
kysely-codegen --url postgres://…/erp_codegen_old --out-file src/types/db.ts
```

For source files that mix concerns across commits: `git show HEAD:path > path`
to get the original, then apply only the edits that belong to the current
commit. Back up FINAL states to `/tmp` first; after the last commit,
`diff -q` working tree vs backups and `build`/`lint`/`test` at HEAD.

---

## Misc gotchas

- `exactOptionalPropertyTypes: true` rejects `{ x: undefined }` for
  `{ x?: T }`. Build the object conditionally:
  ```ts
  const input: Foo = { email };
  if (name !== undefined) input.name = name;
  ```
- Kysely raw updates **do not** auto-bump `@updatedAt`. That's a Prisma-client
  feature only. Set it manually if you want it.
- zsh does NOT word-split unquoted variables (unlike bash):
  ```sh
  CMD="docker exec foo psql -U bar"
  $CMD -c '...'       # treats the whole string as one command in zsh
  ```
  Use a shell function instead of a stored-command variable.
- Prisma 7 flag rename: `migrate diff --from-url` is gone → use
  `--from-config-datasource`.
- IP capture (`request.ip` + Fastify `trustProxy`) on session + audit rows is
  cheap and the first thing you'll want during an incident.

---

## What's still open

- Hash tenant `Session.token` and `PasswordResetToken.token` (raw at rest,
  same risk as the platform side was). The `hashToken` helper is in place;
  it's mechanical work plus updating tenant tests.
- The `health`/bull-board test failure that pre-existed all of this is still
  pre-existing — it needs `QUEUE_REDIS_URL` in the vitest env.
