# Platform Admin (Superadmin) Surface — Reference

> Status: implemented on `feature/auth_flow` (not yet merged). Decision record: [ADR 0002](adr/0002-separate-platform-admin-identity.md). This doc is the operational/reference companion to that ADR.

## Purpose

A **platform operator (superadmin)** provisions tenants, creates each tenant's first `ADMIN` user, and suspends/reactivates tenants. It is a **cross-tenant** actor and is modeled entirely separately from tenant users so the "every business query is tenant-scoped" P0 invariant stays structurally true.

It also fills a gap: before this, there was **no** way to create a tenant or user — they could only be inserted by hand. Provisioning a tenant via the platform surface is now the onboarding path.

## Key design choices (see ADR 0002)

- **Separate identity.** `PlatformAdmin` is its own table — no `tenantId`, no `password`. `SUPER_ADMIN` was deliberately **not** added to `UserRole`.
- **Passwordless, magic-link login.** A superadmin requests a one-time emailed link (32-byte token) and exchanges it for a session. No passwords are stored for the platform identity.
- **IP allowlist, fail-closed.** The whole `/platform/*` surface sits behind an IP allowlist. Non-allowlisted requests get **404** (the surface is hidden, not just forbidden). Empty/unset allowlist = deny all.
- **Defense-in-depth, not the primary control.** The edge network (LB / security group / Cloudflare) is the first line; the app-layer allowlist is the second. Its correctness depends on `TRUST_PROXY` matching the real proxy chain.

## Data model

| Table | Notes |
|---|---|
| `PlatformAdmin` | `id, publicId (uuidv7), email (unique), name, isActive, timestamps`. No `tenantId`, no `password`. |
| `PlatformAdminSession` | `token (unique), adminId, expiresAt`. Mirrors tenant `Session`. Cascade-deletes with the admin. |
| `PlatformAdminLoginToken` | Single-use, single-live, short-TTL magic-link token. Mirrors `PasswordResetToken`. |
| `AuditLog.actorType` | New enum column `USER` (default) \| `PLATFORM_ADMIN`, to disambiguate `actorId`'s id-space. |

Migration: `prisma/migrations/20260524203036_add_platform_admin_identity/`.

## Authentication flow (magic link)

```
1. POST /platform/auth/request-link { email }
     → 200 always (no account enumeration)
     → if the email is a known active admin, a login link is emailed:
       ${APP_BASE_URL}/platform/verify?token=<64-hex>
       (login token TTL: 15 min; issuing a new one supersedes prior unused ones)

2. Admin clicks the link → frontend route /platform/verify reads ?token=
     POST /platform/auth/verify { token }
     → 200 { token: <sessionToken> }   (session TTL: 8 h)
     → 401 if token is invalid / expired / already used

3. Authenticated calls send:  Authorization: Bearer <sessionToken>
```

Session tokens are cached in Redis under `platform-session:<token>` (separate namespace from tenant sessions).

## API reference

All routes are under `/platform`. All require a request from an allowlisted IP (else **404**). The error body for any failure is `{ "error": { "code": string, "message": string } }`.

### `POST /platform/auth/request-link`
- Body: `{ "email": string }`
- `200` (empty body) — always, whether or not the email is known.
- `422 VALIDATION_ERROR` — malformed email.
- Honors optional `Idempotency-Key`.

### `POST /platform/auth/verify`
- Body: `{ "token": string }` (the value from the email link's `?token=`)
- `200` → `{ "token": string }` (the session bearer token)
- `401 UNAUTHORIZED` — invalid / expired / used token.
- `422 VALIDATION_ERROR` — missing token.

### `GET /platform/tenants`  *(auth required)*
- `200` → `{ "tenants": [ { "id": string(uuid), "slug": string, "name": string, "isActive": boolean, "plan": string, "createdAt": string(ISO-8601) } ] }`
- `401 UNAUTHORIZED` — no/invalid session.

### `POST /platform/tenants`  *(auth required)*
- Body: `{ "tenant": { "name": string, "slug": string }, "admin": { "email": string, "name": string } }`
  - `slug` must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, max 63 chars.
- `201` → `{ "tenant": { "id": string(uuid), "slug": string, "name": string }, "admin": { "email": string } }`
- `409 TENANT_SLUG_TAKEN` — slug already in use.
- `422 VALIDATION_ERROR` — invalid body.
- `401 UNAUTHORIZED` — no/invalid session.
- Honors optional `Idempotency-Key` (send a fresh UUID per submit to make retries safe).
- Side effect: creates the tenant + first `ADMIN` user + audit row in one transaction, then emails the new admin a **"set your password"** link (`${APP_BASE_URL}/reset-password?token=...`, the standard reset flow). The platform operator never sets the tenant admin's password.

### `PATCH /platform/tenants/:id`  *(auth required)*
- `:id` is the tenant **publicId (UUID)**.
- Body: `{ "isActive": boolean }`  (`false` = suspend, `true` = reactivate)
- `200` → `{ "id": string(uuid), "slug": string, "name": string, "isActive": boolean }`
- `404 TENANT_NOT_FOUND` — unknown id (indistinguishable from the IP-blocked 404 by design).
- `401 UNAUTHORIZED` — no/invalid session.
- Honors optional `Idempotency-Key`.
- A suspended tenant's users are rejected at login and on every authenticated request (`Tenant.isActive` is already enforced).

## Bootstrapping the first admin

No self-registration. Run as a release step:

```bash
npm run platform:create-admin -- --email ops@example.com --name "Ops Admin"
```

Idempotent on email (re-running reports "already exists", no duplicate). Implemented in `src/scripts/create-platform-admin.ts` (core) + `create-platform-admin.cli.ts` (entry).

## Configuration (env)

| Var | Meaning |
|---|---|
| `PLATFORM_IP_ALLOWLIST` | Comma-separated exact IPs + IPv4 CIDR ranges allowed to reach `/platform/*`. Empty = deny all. Dev: `127.0.0.1,::1`. |
| `TRUST_PROXY` | `true` only behind a trusted proxy that sets `X-Forwarded-For`, so `request.ip` is the real client. |
| `APP_BASE_URL` | Base for the emailed magic-link and reset URLs. |
| `RESEND_API_KEY` | **Required in practice** — without email, no one can receive a login link. (With it unset, the surface still runs but login is unusable.) |

Internal TTLs (in `src/shared/config`): platform session 8 h, login token 15 min.

## Audit

Tenant-targeted platform actions write `AuditLog` rows with `actorType = 'PLATFORM_ADMIN'`, `actorId = <PlatformAdmin.id>`, `tenantId = <target tenant>`:
- `platform.tenant_created`
- `platform.tenant_suspended`
- `platform.tenant_reactivated`

## Known gaps / follow-ups

- **No `/platform/auth/logout`.** Server-side session revocation for platform admins isn't implemented; logout is client-side (drop the token). Sessions still expire after 8 h.
- **Platform login/logout are not in the tenant audit ledger** — `AuditLog.tenantId` is `NOT NULL` and these have no tenant. Capture via structured logs.
- **Email templates** use placeholder `from: 'no-reply@themadhu.dev'`.
- **No rate limiting** (deferred — ADR 0001). `request-link` can be used to flood an admin's inbox; mitigated only by superseding prior unused tokens.

## File map

```
docs/adr/0002-separate-platform-admin-identity.md   decision record
prisma/migrations/20260524203036_add_platform_admin_identity/
src/modules/platform/
  platform.routes.ts        routes + IP-allowlist onRequest guard
  platform.service.ts       magic-link auth, tenant provisioning, suspend/reactivate
  platform.repository.ts    Kysely queries (incl. intentionally unscoped listTenants)
  platform.schemas.ts       Zod request schemas
  platform.errors.ts        TenantSlugTakenError, TenantNotFoundError
  jobs/send-login-link-email.ts
  __tests__/platform.routes.test.ts
src/shared/auth/
  authenticate-platform.ts  request.platformAdmin principal
  platform-session.ts       cache key + cached shape
  ip-allowlist.ts           hand-rolled IPv4 CIDR + exact matcher (fail-closed)
src/scripts/
  create-platform-admin.ts        bootstrap core (testable)
  create-platform-admin.cli.ts    CLI entry
```
