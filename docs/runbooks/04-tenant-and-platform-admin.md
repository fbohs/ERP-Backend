# Runbook: Tenants & Platform Admin Management

> Covers onboarding a new tenant, and creating/updating/deactivating platform admins.

---

## Part 1 — Add a New Tenant

**What it does:** Creates a `Tenant` row plus its first admin `User`, writes an audit log entry, and enqueues a welcome email to the admin.

### Prerequisites

You must be authenticated as a platform admin. If you have no active session, complete the magic-link login first (see Part 2 — Authenticate as Platform Admin below).

Your IP must be in `PLATFORM_IP_ALLOWLIST`. If the endpoint returns `404`, check `TRUST_PROXY` and IP allowlist config — see `docs/known-issues.md`.

### Steps

**1. Create the tenant:**

```bash
curl -X POST https://<your-app>/platform/tenants \
  -H "Authorization: Bearer <platform-session-token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <unique-uuid>" \
  -d '{
    "tenant": { "name": "Acme Corp", "slug": "acme-corp" },
    "admin": {
      "name": "Jane Smith",
      "email": "jane@acmecorp.com"
    }
  }'
```

Expected: `201 Created` with `tenantId`, `userId`, and a temporary password in the response body.

**2. Confirm the welcome email arrived.** The tenant's first admin receives a welcome email with their temporary password and login URL. Check the Resend dashboard if it doesn't arrive within a minute.

### Idempotency

The `Idempotency-Key` header is required. If the request times out and you need to retry, use the **same key** — the endpoint returns the original result without creating a duplicate tenant.

### What can go wrong

**`409 Conflict`** — the `slug` is already taken. Slugs are globally unique. Choose a different one.

**`404` on the platform endpoint** — IP not in `PLATFORM_IP_ALLOWLIST`, or `TRUST_PROXY` misconfigured. See `docs/known-issues.md`.

**Welcome email not received** — Resend domain/key mismatch is the most common cause. See `docs/known-issues.md`.

---

## Part 2 — Platform Admin Authentication (Magic-Link)

Platform admins have no password — they authenticate via a time-limited magic link sent to their email.

**Request a login link:**
```bash
curl -X POST https://<your-app>/platform/auth/request-login \
  -H "Content-Type: application/json" \
  -d '{ "email": "admin@example.com" }'
```

**Exchange the token for a session:**
```bash
curl -X POST https://<your-app>/platform/auth/verify-login \
  -H "Content-Type: application/json" \
  -d '{ "token": "<token-from-email>" }'
```

Response contains the `Bearer` token to use in subsequent platform requests.

---

## Part 3 — Platform Admin Lifecycle

All commands below connect directly to the database and run outside the HTTP server.

### Create a platform admin

```bash
DATABASE_URL=<prod-url> pnpm platform:create-admin -- --email admin@example.com --name "Jane Smith"
```

Expected: `Platform admin created` with `publicId`.
If the admin already exists: `Platform admin already exists — no change` (idempotent — safe to re-run).

The new admin has no password and authenticates via magic-link from day one.

### Rename a platform admin

```bash
DATABASE_URL=<prod-url> pnpm platform:update-admin -- --email admin@example.com --name "Jane Doe"
```

### Deactivate a platform admin (blocks login, does not delete)

```bash
DATABASE_URL=<prod-url> pnpm platform:update-admin -- --email admin@example.com --active false
```

### Reactivate a platform admin

```bash
DATABASE_URL=<prod-url> pnpm platform:update-admin -- --email admin@example.com --active true
```

### Revoke all active sessions for a platform admin

```bash
DATABASE_URL=<prod-url> pnpm platform:revoke-sessions -- --email admin@example.com
```

Takes effect immediately — no cache lag because platform sessions are DB-only (no Redis).
Run this when offboarding an admin or responding to a suspected compromise.
