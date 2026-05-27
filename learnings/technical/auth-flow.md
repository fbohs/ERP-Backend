# Auth Flow — Technical Reference

## Overview

The auth system implements opaque session-based authentication with a Redis cache layer, flat RBAC, and a BullMQ-backed password reset flow. It is designed for a multi-tenant ERP SaaS where correctness and instant revocability take precedence over stateless convenience.

---

## Architecture Decisions

### Why opaque sessions over JWTs

JWTs are stateless — the server cannot revoke them without a denylist that defeats the purpose. In an ERP context, an employee can be terminated mid-day. Their access must be cut off instantly. Opaque sessions stored in PostgreSQL and cached in Redis make revocation a single `DELETE` statement. The tradeoff (a Redis/DB lookup per request) is mitigated by the cache-first strategy.

### Why two Redis instances

| Instance | Purpose | Persistence |
|---|---|---|
| Session Redis (`REDIS_URL`) | Session cache — ephemeral. Lost on restart, that is acceptable since the DB is the source of truth. | None (cache can be cold-started) |
| Queue Redis (`QUEUE_REDIS_URL`) | BullMQ job queue — durable. Jobs must survive container restarts. | AOF (`appendonly yes`, `appendfsync everysec`) |

Mixing them in one Redis instance creates a conflict: session cache benefits from LRU eviction (old sessions are cheap to recompute from DB), but BullMQ jobs must never be evicted. Separate instances let each be tuned independently.

### Why the BullMQ worker runs inside the app process

At early stage, running a separate worker process adds operational overhead without proportional benefit. The key insight: job durability is provided by Redis (AOF persistence), not by the worker process. If the app crashes, jobs survive in Redis and are picked up when the app restarts. The worker does not need to be always-on to guarantee job delivery — only the Redis queue does.

When scale demands it, the worker can be extracted to `src/workers/email.worker.ts` as its own entry point with zero code changes. The architecture already supports it.

---

## Database Schema

```sql
-- Identity tables (no tenantId — auth is global, not tenant-scoped)

CREATE TABLE "User" (
    id          BIGSERIAL PRIMARY KEY,
    publicId    UUID UNIQUE DEFAULT uuidv7(),   -- externally exposed ID
    tenantId    BIGINT NOT NULL,                -- FK to Tenant (enforced at app layer)
    email       TEXT UNIQUE,                    -- globally unique login identifier
    password    TEXT NOT NULL,                  -- argon2id hash
    role        "UserRole" DEFAULT 'VIEWER',
    isActive    BOOLEAN DEFAULT true,
    ...
);

CREATE TABLE "Session" (
    id          BIGSERIAL PRIMARY KEY,
    token       TEXT UNIQUE,                    -- 64-char hex (32 random bytes)
    userId      BIGINT NOT NULL,
    expiresAt   TIMESTAMP NOT NULL,             -- absolute, never sliding
    createdAt   TIMESTAMP DEFAULT now()
);

CREATE TABLE "PasswordResetToken" (
    id          BIGSERIAL PRIMARY KEY,
    token       TEXT UNIQUE,                    -- 64-char hex (32 random bytes)
    userId      BIGINT NOT NULL,
    expiresAt   TIMESTAMP NOT NULL,             -- 30 minutes from creation
    usedAt      TIMESTAMP,                      -- NULL = unused. Set on consumption, never deleted.
    createdAt   TIMESTAMP DEFAULT now()
);

-- Indexes: Session(userId), Session(expiresAt), PasswordResetToken(userId), PasswordResetToken(expiresAt)
```

**Why `usedAt` instead of deleting the row on use:** deleting removes the audit trail. Keeping the row with `usedAt` set lets you answer "when was this token used?" and detect replay attempts.

**Why no `tenantId` on Session and PasswordResetToken:** these are identity infrastructure tables, accessed by token (globally unique). The tenant context is derived from the user row they join to.

---

## Login Flow

```
POST /auth/login  { email, password }
```

1. Look up `User` by email — email is globally unique across all tenants (no tenant-first lookup needed).
2. Check `user.isActive` and `user.tenant.isActive` — terminated user or suspended tenant both return `401`.
3. `argon2.verify(user.password, password)` — returns `401` on mismatch. Same error message as step 2 to prevent user enumeration.
4. Generate session token: `crypto.randomBytes(32).toString('hex')` — 64 hex characters, 256 bits of entropy.
5. Compute `expiresAt = now + 28800 seconds` (8 hours absolute — never sliding).
6. Insert `Session` row.
7. Write to Redis: `SETEX session:<token> 28800 <JSON payload>` where payload is `{ userId, tenantId, role }`.
8. Return `{ token, user: { id, name, role }, tenant: { id, slug, name } }`.

**Why `crypto.randomBytes` and not argon2 for token generation:** argon2 is a password hashing algorithm, not a random number generator. It requires an input to hash. The token needs to be unpredictable (high entropy random bytes), not slow (argon2 is intentionally slow to resist brute-force on stolen hashes). These are different tools for different jobs.

---

## Request Authentication Middleware

Every protected route runs `authenticate` as a Fastify `preHandler`. The middleware lives in `src/shared/auth/authenticate.ts`.

```
Authorization: Bearer <token>
```

**Fast path (Redis hit):**
1. `GET session:<token>` from Redis.
2. Parse JSON → `{ userId, tenantId, role }`.
3. Attach to `request.user`.
4. Done. No DB query.

**Slow path (Redis miss — cold start or cache eviction):**
1. Query `Session JOIN User JOIN Tenant WHERE Session.token = ?`.
2. If not found → `401`.
3. If `user.isActive = false` or `tenant.isActive = false` → `401`.
4. If `session.expiresAt <= now()` → `401`.
5. Compute remaining TTL: `Math.floor((expiresAt - now) / 1000)`.
6. `SETEX session:<token> <remainingTtl> <JSON>` — re-populate cache with correct TTL, not the full 8 hours.
7. Attach to `request.user`.

**Why re-populate with remaining TTL:** if you set `SETEX` to the full 8 hours on a cache miss, a session that is 7 hours old would be given a fresh 8-hour cache window, effectively extending its lifetime. Remaining TTL ensures the cache never outlives the DB record.

---

## Logout Flow

```
DELETE /auth/logout
Authorization: Bearer <token>
```

1. `authenticate` preHandler runs first — validates the token. If already invalid, returns `401` before the handler executes.
2. Extract token from `Authorization` header.
3. `Promise.all`: delete `Session` row from DB + `DEL session:<token>` from Redis.

Parallel execution is safe here since neither operation depends on the other's result.

---

## RBAC

### Design: flat permission map

Roles are a fixed enum (`ADMIN`, `INVENTORY_MANAGER`, `PURCHASING_MANAGER`, `SALES_MANAGER`, `WAREHOUSE_OPERATOR`, `ACCOUNTANT`, `VIEWER`). No dynamic role creation. The permission matrix lives in one file: `src/shared/auth/permissions.ts`.

```ts
type Permission =
  | 'inventory:read' | 'inventory:write'
  | 'purchase-order:read' | 'purchase-order:write' | 'purchase-order:approve'
  | ...

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  ADMIN: new Set(ALL_PERMISSIONS),
  INVENTORY_MANAGER: new Set(['inventory:read', 'inventory:write', ...]),
  ...
}
```

**Why flat (not additive/hierarchical):** additive inheritance ("SALES_MANAGER inherits VIEWER") means "what can SALES_MANAGER do?" requires tracing a chain. Flat means reading one entry. For a compliance-sensitive ERP where auditing permissions is a legal requirement, flat wins.

### Two enforcement layers

**Layer 1 — Route preHandler (coarse-grained):**
```ts
// "Can this role access this endpoint at all?"
app.post('/purchase-orders/:id/approve', {
  preHandler: [authenticate, authorize('purchase-order:approve')],
}, handler);
```

**Layer 2 — Service method (conditional/data-dependent):**
```ts
// "Can this specific user do this specific operation on this data?"
if (po.totalAmount.gt(10_000) && role !== 'ADMIN') {
  throw new ForbiddenError('Orders above $10,000 require ADMIN approval');
}
```

**Why not at DB level (PostgreSQL RLS):** Connection pooling makes `SET LOCAL` unreliable outside explicit transactions. With Kysely's `pg.Pool`, connections are shared and reused — a `SET LOCAL` on a borrowed connection may not persist across the pool boundary. Additionally, RLS policies live in DDL (migrations), splitting the permission logic between `permissions.ts` and migration SQL. The application layer keeps the entire answer in one place.

---

## Password Reset Flow

### Forgot Password

```
POST /auth/forgot-password  { email }
```

1. Look up `User` by email.
2. **If not found, inactive, or tenant inactive → return `200` immediately.** Never reveal whether the email exists (prevents email enumeration attacks).
3. Generate token: `crypto.randomBytes(32).toString('hex')`.
4. Insert `PasswordResetToken` row with `expiresAt = now + 1800 seconds` (30 minutes).
5. **Enqueue BullMQ job** (outside any DB transaction — single insert, no coordination needed):
   - Queue: `auth.password-reset-email`
   - JobId: `password-reset.<token>` (deterministic — prevents duplicate emails if endpoint is called twice before the first job runs)
   - Payload: `{ email, name, resetUrl }`
   - Retry: 3 attempts, exponential backoff starting at 5s
6. Return `200`.

**Why async email via BullMQ and not inline Resend call:** The HTTP response must not depend on email delivery. Resend could be slow or rate-limited. Decoupling via a queue means the HTTP handler returns immediately and the email is delivered eventually with retries.

### Reset Password

```
POST /auth/reset-password  { token, newPassword }
```

1. Look up `PasswordResetToken JOIN User` by token. If not found → `401`.
2. If `expiresAt <= now()` → `401`.
3. If `usedAt != null` → `401` (already used — replay attempt).
4. `argon2.hash(newPassword)` — hash before entering the transaction (argon2 is CPU-intensive; don't hold a DB connection during it).
5. **Transaction:**
   - `getUserSessionTokens(userId)` — fetch all active session tokens **before** deleting them (needed to evict Redis).
   - `updateUserPassword(userId, passwordHash)`
   - `markTokenUsed(token)` — sets `usedAt = now()`, does not delete the row (audit trail).
   - `deleteUserSessions(userId)` — all sessions for this user, not just the current device.
6. **After transaction commits:** `Promise.all(sessionTokens.map(t => redis.del(sessionKey(t))))` — evict all session cache entries.
7. Return `200`.

**Why fetch session tokens inside the transaction:** they must be consistent with the delete. Fetching before the transaction risks a race where a new session is created between the fetch and the delete. Fetching inside the transaction reads the same snapshot that the delete acts on.

**Why Redis eviction is outside the transaction:** calling external systems (Redis) inside a DB transaction is forbidden. If the Redis call blocks or errors, it would hold the DB connection open and potentially deadlock. Redis eviction is a best-effort cache invalidation — if it fails, the next authenticate middleware hit will find the session gone from the DB and return `401` anyway.

### Email Worker

The worker (`src/workers/email.worker.ts`) runs inside the app process via `startEmailWorker(queueRedisUrl, resendApiKey)` called in `buildApp`. It connects to the dedicated queue Redis and processes `auth.password-reset-email` jobs by calling `resend.emails.send(...)`.

If `RESEND_API_KEY` is not configured (local dev, CI), the worker is not started. The queue still receives jobs — they sit in Redis until a configured worker picks them up.

---

## Token Generation: `crypto.randomBytes` vs argon2

| | `crypto.randomBytes(32)` | `argon2.hash` |
|---|---|---|
| Purpose | Generate unpredictable random data | Derive a slow, memory-hard hash from input |
| Speed | Microseconds | ~100ms intentionally |
| Use case | Session tokens, reset tokens | Storing user passwords |
| Output | Unpredictable bytes | Deterministic given same input + salt |

Session tokens and reset tokens require **unpredictability** (entropy). Passwords require **resistance to brute-force on the hash** (slowness). These are different security properties served by different tools.

---

## File Map

```
src/
  shared/
    auth/
      authenticate.ts     — createAuthenticate(db, redis): preHandler factory
      authorize.ts        — authorize(...permissions): preHandler factory
      permissions.ts      — Permission type + ROLE_PERMISSIONS flat map
      session.ts          — sessionCacheKey helper + CachedSession type
      index.ts            — barrel
    cache/
      redis.ts            — createRedis(url): IORedis factory
    db/
      index.ts            — createDb(url): Kysely factory
    email/
      resend.ts           — createResend(apiKey): Resend factory
    config/
      index.ts            — typed config (sessionTtlSeconds, passwordResetTtlSeconds, etc.)

  modules/auth/
    auth.repository.ts    — Kysely queries (session, user, password reset token)
    auth.service.ts       — login, logout, forgotPassword, resetPassword
    auth.routes.ts        — Fastify plugin: POST /auth/login, DELETE /auth/logout,
                            POST /auth/forgot-password, POST /auth/reset-password
    auth.schemas.ts       — Zod: LoginBody, ForgotPasswordBody, ResetPasswordBody
    jobs/
      send-password-reset-email.ts  — queue definition + enqueuePasswordResetEmail
    __tests__/
      auth.routes.test.ts — Testcontainers integration tests (Postgres 18 + Redis)

  workers/
    email.worker.ts       — BullMQ worker: consumes password-reset-email queue, calls Resend

  types/
    fastify.d.ts          — FastifyRequest.user augmentation
    db.ts                 — Kysely DB types (generated by kysely-codegen)
```

---

## Environment Variables

| Variable | Purpose | Required in prod |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `REDIS_URL` | Session cache Redis | Yes |
| `QUEUE_REDIS_URL` | BullMQ queue Redis (AOF-enabled) | Yes |
| `RESEND_API_KEY` | Resend email API key | Yes |
| `APP_BASE_URL` | Base URL for reset links in emails | Yes |
| `SESSION_TTL_SECONDS` | Not an env var — hardcoded to 28800 | — |
| `PASSWORD_RESET_TTL_SECONDS` | Not an env var — hardcoded to 1800 | — |

---

## What Is Not Implemented (and Why)

| Feature | Decision |
|---|---|
| MFA / TOTP | Deferred — requires ADR on authenticator app vs SMS |
| Admin force-reset | Self-service only implemented first. Admin reset reuses same token table and reset endpoint — initiation endpoint only differs. |
| Rate limiting on forgot-password | Not implemented yet. Should be Redis-backed sliding window (Redis is already in stack). Without it, endpoint can be used to exhaust email quota. |
| Refresh tokens | Not applicable — opaque sessions with DB backing don't need refresh tokens. Refresh tokens exist to extend JWT lifetimes without re-authentication; sessions extend by simply not expiring. |
| Session list (active devices) | Not implemented. Sessions table has the data; an endpoint to list and revoke individual sessions is a UI concern deferred to a later sprint. |
