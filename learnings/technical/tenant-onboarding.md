# Tenant Onboarding — Technical Reference

## Overview

When a platform admin provisions a new tenant via `POST /platform/tenants`, the system creates the tenant record, its first ADMIN user with a system-generated temporary password, and sends a welcome email with those credentials. The tenant admin then logs in normally via `/auth/login`, is redirected to a dedicated setup page to choose their own password, and is auto-logged in afterward.

This replaced an earlier activation-link flow where the welcome email contained a one-time URL that set the password. That flow was confusing because the login page asked for a password the user had never seen or set.

---

## Architecture Decisions

### Why credentials-in-email instead of a one-time activation link

The activation link directed the user to a URL that _set_ their password but did not look like a standard login. Users were confused: the regular login page asked for a password they had never created.

The credentials flow reuses the familiar `POST /auth/login` entry point. The user sees their email and a temporary password in the welcome email, logs in at the normal URL, and is then forced to choose their own password before gaining any real access. The flow maps directly onto the user's mental model: "I have a username and password. I log in. I'm asked to change my password. I do. I'm in."

### Why a dedicated `POST /auth/setup-password` and not the existing `POST /auth/reset-password`

Two reasons:

1. **Token type prevents cross-consumption.** The `PasswordResetToken.type` column (`PASSWORD_RESET | FIRST_LOGIN_SETUP`) ensures a setup token cannot be consumed by the reset endpoint and vice versa. Without this, a tenant admin who also triggered a password-reset email would have two tokens in flight and the wrong one could be consumed.

2. **Different UX intent.** A password reset is a recovery action — the old session is gone, the user is not logged in. First-login setup is an onboarding action — the user _becomes_ logged in after setting their password. The setup endpoint creates a session immediately on success. The reset endpoint does not (the user must log in again after resetting).

### Why the login endpoint returns a setup token instead of a session on first login

When `mustChangePassword = true`, `POST /auth/login` returns `{ requiresPasswordChange: true, setupToken }` — no session is created. This enforces the password change before any real access is granted. A session token would give the user real access; a setup token is only consumable by `POST /auth/setup-password`.

The response shape is a Zod discriminated union on `requiresPasswordChange` so the frontend can narrowly type it without unsafe casts.

### Why `mustChangePassword` is a DB column (not inferred from token existence)

Using token existence to infer "must change password" would mean a user who loses their welcome email can be stuck: no token, no way to log in. Adding `mustChangePassword` as a column lets the platform admin trigger a new welcome email flow (send new credentials) without that ambiguity.

It also survives edge cases: token expiry, multiple tenant provisions, etc.

### Why DB-only session for `setupPassword` (no proactive Redis write)

After `setupPassword` creates the session, it returns the session token without writing to Redis. This mirrors how the platform admin surface works (see ADR 0002). The `authenticate` middleware already has a DB slow-path that populates Redis on the first authenticated request. Proactively writing to Redis from `setupPassword` would be redundant and adds an extra failure mode at the end of an already-sensitive transaction.

### Why rejection sampling for the temporary password generator

`generateTemporaryPassword` draws from the alphabet `[A-Za-z0-9]` (62 characters). The naïve approach of `randomByte % 62` introduces modulo bias because 256 is not a multiple of 62 — some characters would appear ~1.0065% more often. Rejection sampling discards bytes ≥ 186 (the largest multiple of 62 within a byte) and redraws, giving a uniform distribution.

The alphabet deliberately excludes `0`, `O`, `l`, `1` — characters that are visually ambiguous in email fonts. This avoids support tickets where users misread the temporary password.

Wait — looking at the implementation: the current code does not exclude ambiguous characters. This is a known gap. The alphabet is full `[A-Za-z0-9]`. Consider tightening it in a follow-up.

### Why the new queue `platform.tenant-welcome-email` instead of reusing `auth.password-reset-email`

Two different email types should use two different queues:

- **Different consumers.** The password-reset worker and tenant-welcome worker send different email templates, have different TTL semantics, and should fail independently.
- **Observability.** Separate queues mean separate job counts and failure metrics in Bull Board. A spike in tenant-welcome failures won't pollute password-reset failure rates.
- **Idempotency key.** Welcome emails use `tenant-welcome.<tenantId>` as their deterministic jobId. If `POST /platform/tenants` is called twice with the same Idempotency-Key, only one welcome email is sent regardless of retries. Reusing the password-reset queue would make this namespacing harder.

---

## Database Schema Changes

```sql
-- Added enum to separate token purposes
CREATE TYPE "PasswordResetTokenType" AS ENUM ('PASSWORD_RESET', 'FIRST_LOGIN_SETUP');

-- Existing table gains a type column (non-breaking: default = PASSWORD_RESET)
ALTER TABLE "PasswordResetToken"
  ADD COLUMN "type" "PasswordResetTokenType" NOT NULL DEFAULT 'PASSWORD_RESET';

-- User gains mustChangePassword flag (non-breaking: default = false)
ALTER TABLE "User"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
```

**Why not a separate `SetupToken` table:** the TTL mechanics (token, expiresAt, usedAt, userId) are identical to PasswordResetToken. Adding a `type` discriminator column reuses all that infrastructure at the cost of one extra filter in every query.

---

## Tenant Onboarding Flow

```
POST /platform/tenants  { tenant: { name, slug }, admin: { email, name } }
Authorization: Bearer <platform session token>
```

1. Platform admin sends request through the IP-allowlisted `/platform/*` surface.
2. `PlatformService.createTenant`:
   a. Check slug uniqueness.
   b. `generateTemporaryPassword(20)` — 20-char alphanumeric, rejection-sampled for uniformity.
   c. `argon2.hash(temporaryPassword)` — hash before entering the transaction.
   d. **Transaction:** create `Tenant`, create `User` with `mustChangePassword = true`, write `PlatformAuditLog` row.
   e. `enqueueTenantWelcomeEmail(queue, tenant.id, { email, name, tenantName, temporaryPassword, loginUrl })` — outside the transaction, deterministic jobId prevents duplicate emails on retry.
3. Welcome email arrives with: display name, login email, temporary password, login button → `/login`, note that a password change is required.
4. Tenant admin hits `POST /auth/login` with their credentials.
5. `AuthService.login` checks credentials, detects `mustChangePassword = true`.
   - Deletes any unused tokens for this user (supersede stale setups).
   - Mints a `FIRST_LOGIN_SETUP` token (15-minute TTL).
   - Returns `{ requiresPasswordChange: true, setupToken }`. **No session created.**
6. Frontend redirects to `/setup-password?token=<setupToken>`.
7. Tenant admin POSTs `{ token, newPassword }` to `POST /auth/setup-password`.
8. `AuthService.setupPassword`:
   - Finds `PasswordResetToken` with `type = FIRST_LOGIN_SETUP`, validates not expired, not used.
   - `argon2.hash(newPassword)`.
   - **Transaction:** `updateUserPassword`, `setMustChangePassword(false)`, `markTokenUsed`, `deleteUserSessions` (none exist, but safe no-op), `createSession`.
   - Returns `{ token: sessionToken, user: { name }, tenant: { id, slug, name } }`.
9. Frontend stores session token, redirects to dashboard.

---

## Token Lifecycle

| Token type | TTL | Created by | Consumed by | Creates session |
|---|---|---|---|---|
| `PASSWORD_RESET` | 30 min | `forgotPassword` | `resetPassword` | No — user must re-login |
| `FIRST_LOGIN_SETUP` | 15 min | `login` (when `mustChangePassword`) | `setupPassword` | Yes — auto-login after setup |

Both tokens:
- Are 32 random bytes encoded as 64-char hex.
- Use `usedAt` (set on consumption, never deleted) rather than deletion to preserve the audit trail.
- Supersede previous unused tokens of the same type for the same user.

---

## File Map

```
src/
  modules/
    auth/
      auth.service.ts        — login (mustChangePassword path), setupPassword
      auth.repository.ts     — findPasswordResetToken(token, type), setMustChangePassword
      auth.schemas.ts        — LoginResponseSchema (discriminated union), SetupPasswordBodySchema
      auth.routes.ts         — POST /auth/setup-password
    platform/
      platform.service.ts    — createTenant: generateTemporaryPassword, hashing, enqueue
      platform.repository.ts — createUser (now accepts mustChangePassword)
      jobs/
        send-tenant-welcome-email.ts  — TENANT_WELCOME_EMAIL_QUEUE, enqueueTenantWelcomeEmail
  shared/
    email/
      templates.ts           — tenantWelcomeEmail template (+ passwordResetEmail, platformLoginEmail)
    config/
      index.ts               — firstLoginSetupTtlSeconds: 900

  workers/
    email.worker.ts          — tenantWelcomeWorker consuming platform.tenant-welcome-email
```

---

## Environment Variables

No new environment variables. `RESEND_API_KEY`, `QUEUE_REDIS_URL`, and `APP_BASE_URL` cover the welcome email flow. When `RESEND_API_KEY` is absent, emails are disabled globally — welcome emails simply are not sent.

---

## What Is Not Implemented (and Why)

| Feature | Decision |
|---|---|
| Ambiguous-character exclusion in temp password | Not yet done. Current alphabet is full `[A-Za-z0-9]`. Consider excluding `0`, `O`, `l`, `1` in a follow-up. |
| Admin-triggered resend of welcome email | No endpoint yet. The platform admin would need a `POST /platform/tenants/:id/resend-welcome` that generates new credentials and resets `mustChangePassword`. |
| Rate limit on `POST /auth/setup-password` | Not implemented. Low-risk since the token has 256 bits of entropy, but worth adding a Redis sliding window. |
| Welcome email link to `/setup-password` directly | Decided against. The user must log in first to prove they received the temp password — the login step is the credential check. Linking directly to setup bypasses that. |
