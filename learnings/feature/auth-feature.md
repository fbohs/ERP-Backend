# Authentication & Access Control — Feature Document

**Domain:** Identity & Security
**Module:** `src/modules/auth`
**Status:** Implemented (self-service auth + RBAC)
**Last updated:** 2026-05-14

---

## Problem Statement

An ERP system handles payroll, inventory, purchase orders, and financial ledgers. Access to these systems must be tightly controlled. The following must hold:

- Only authenticated users can access any business data.
- A user's access level is determined by their role in the organisation.
- When an employee is terminated, their access must be cut off immediately — not at next token expiry.
- A user who forgets their password must be able to recover access securely without involving an administrator.
- An attacker who intercepts a password reset email must not gain permanent access by replaying it.

---

## Who Are the Users

| Role | Who they are | What they need |
|---|---|---|
| ADMIN | IT manager, business owner | Full access — can manage users, approve everything |
| INVENTORY_MANAGER | Warehouse manager | Read/write products, inventory, warehouses |
| PURCHASING_MANAGER | Procurement lead | Create and approve purchase orders, manage suppliers |
| SALES_MANAGER | Sales team lead | Create and confirm sales orders, manage pricing |
| WAREHOUSE_OPERATOR | Floor staff | Receive goods, update stock, ship orders |
| ACCOUNTANT | Finance team | Read-only access to orders, suppliers, reports |
| VIEWER | Auditor, intern, read-only stakeholder | Read-only across most modules |

---

## Features in Scope

### 1. Login

**User story:** As a user, I want to log in with my email and password so I can access the ERP system.

**Flow:**
1. User submits email and password.
2. System verifies credentials.
3. System returns a session token valid for 8 hours.
4. Every subsequent request includes the token in the `Authorization: Bearer <token>` header.

**Edge cases and how they are handled:**

| Case | Response |
|---|---|
| Email does not exist | `401 Unauthorized` — same message as wrong password (no user enumeration) |
| Wrong password | `401 Unauthorized` |
| User account is deactivated (`isActive = false`) | `401 Unauthorized` |
| Tenant/company account is suspended (`isActive = false`) | `401 Unauthorized` |
| Missing or malformed request body | `422 Unprocessable Entity` |

**Session design:**
- Sessions are **absolute** — they expire exactly 8 hours after creation, regardless of activity. A user who leaves a browser tab open overnight will need to log in again the next morning.
- Sessions are **per-device** — logging in on a new device creates a new session. Existing sessions are not affected.
- A single user can have multiple active sessions simultaneously (e.g. desktop + mobile).

**Why 8 hours:** ERP users are office workers on defined shifts. 8 hours aligns with a working day. A session that lasts longer than a working day increases the exposure window if a device is left unlocked.

---

### 2. Logout

**User story:** As a user, I want to log out so that my session is immediately invalidated.

**Flow:**
1. User sends a logout request with their current token.
2. System deletes the session from the database.
3. System removes the session from the Redis cache.
4. Any subsequent request with the same token returns `401`.

**Edge cases:**

| Case | Response |
|---|---|
| Token is missing or malformed | `401 Unauthorized` |
| Token already logged out (replayed logout) | `401 Unauthorized` |
| Token is expired | `401 Unauthorized` |

**Immediate revocation:** unlike JWT-based systems, session invalidation is instant. There is no window between logout and the system accepting old tokens. This is critical for employee offboarding.

---

### 3. Role-Based Access Control (RBAC)

**User story:** As a business owner, I want to ensure that warehouse operators cannot approve purchase orders and accountants cannot modify inventory, so that business processes require appropriate authorisation.

**How it works:**
Every protected endpoint declares which permissions are required. The system checks the requesting user's role against a fixed permission matrix at the time of each request. No DB lookup is needed — the matrix is static code.

**Permission matrix (summary):**

| Permission | ADMIN | INV_MGR | PUR_MGR | SALES_MGR | WH_OP | ACCT | VIEWER |
|---|---|---|---|---|---|---|---|
| inventory:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| inventory:write | ✓ | ✓ | — | — | ✓ | — | — |
| purchase-order:approve | ✓ | — | ✓ | — | — | — | — |
| sales-order:confirm | ✓ | — | — | ✓ | — | — | — |
| price-list:write | ✓ | — | — | ✓ | — | — | — |
| user:write | ✓ | — | — | — | — | — | — |
| report:read | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |

**Two levels of enforcement:**

1. **Route level** — "Can this role access this endpoint?" Checked on every request before the handler runs. A `WAREHOUSE_OPERATOR` hitting the purchase order approval endpoint gets `403 Forbidden` before any business logic executes.

2. **Service level** — "Can this user do this specific thing?" For rules that depend on data, not just role. Example: a `PURCHASING_MANAGER` can approve purchase orders up to $10,000; above that requires `ADMIN` co-approval. This cannot be expressed as a simple role check — it requires reading the order amount.

**What RBAC does not cover:**
- Row-level ownership (e.g. "sales manager can only see their own region's orders") — not implemented. All users of a given role see all data within their tenant.
- Permission delegation — a manager cannot grant their permissions to a subordinate.

---

### 4. Forgot Password

**User story:** As a user who has forgotten my password, I want to receive a password reset link by email so I can regain access without contacting IT.

**Flow:**
1. User submits their email address.
2. System always responds with `200 OK` — regardless of whether the email is registered.
3. If the email is registered and the account is active, a password reset link is sent asynchronously.
4. The link expires in 30 minutes.

**Why always `200`:** If the response differed between "email found" and "email not found", an attacker could enumerate valid email addresses by submitting emails and checking the response. Same response prevents this.

**Email delivery:**
- Email is sent asynchronously via a background job queue (BullMQ).
- The HTTP response does not wait for the email to be delivered.
- If the email fails to send (e.g. temporary Resend outage), it is automatically retried up to 3 times with exponential backoff.
- If delivery fails after 3 attempts, the job is recorded as failed. The user can request another reset link.

**Duplicate requests:**
- If a user submits forgot-password twice before receiving the email, both requests create separate tokens. Each link is valid independently.
- However, only one job is enqueued per token (deterministic job ID). If the same request is submitted twice in rapid succession before the first job is processed, the second submission does not create a duplicate email.

**Edge cases:**

| Case | Response |
|---|---|
| Email not registered | `200 OK` (no email sent) |
| User account deactivated | `200 OK` (no email sent) |
| Tenant account suspended | `200 OK` (no email sent) |
| Invalid email format (e.g. "notanemail") | `422 Unprocessable Entity` |
| Multiple requests before first link is used | Each creates a valid, independent token |

---

### 5. Reset Password

**User story:** As a user who has received a reset link, I want to set a new password so I can log in again.

**Flow:**
1. User clicks the reset link, which contains the token as a URL parameter.
2. Frontend submits `{ token, newPassword }`.
3. System validates the token.
4. System hashes the new password and saves it.
5. System invalidates **all active sessions** for this user across all devices.
6. System returns `200 OK`.
7. User must log in again with the new password.

**Token validation rules:**

| Condition | Response |
|---|---|
| Token not found | `401 Unauthorized` |
| Token expired (older than 30 minutes) | `401 Unauthorized` |
| Token already used | `401 Unauthorized` |
| Valid token | `200 OK` |

**All-session invalidation on reset:**
When a password is reset, every active session for that user — on every device — is deleted. This is a security requirement: if an attacker triggered the password reset (e.g. by intercepting an email), they could be logged in as the user on another device. Invalidating all sessions ensures the legitimate user regains exclusive control immediately after setting the new password.

**Token single-use enforcement:**
Once a token is used, it is marked with a `usedAt` timestamp. The record is never deleted — this provides an audit trail of when each reset occurred. A used token can never be used again, even if it has not yet expired.

**Password strength requirement:**
New password must be at least 8 characters. No complexity rules are enforced beyond this at the API level (frontend may enforce additional rules).

**What happens to old sessions:**
All `Session` rows for the user are deleted from the database. Redis cache entries for those sessions are evicted immediately. Any request using an old session token after a password reset receives `401` — including the attacker's session if they were logged in.

---

## What Is Not in Scope (This Sprint)

| Feature | Notes |
|---|---|
| Admin-initiated password reset | Admin submits another user's ID and a reset email is sent to that user. Reuses the same token infrastructure. Planned. |
| Multi-factor authentication | Requires decision on delivery method (TOTP app vs SMS). Needs ADR. |
| "Remember me" (extended session) | 8h is fixed. A "keep me logged in" option would grant 30-day sessions, revocable per device. Not implemented. |
| Active session list | Users cannot see or manage their own active sessions. The data exists (Session table); a UI endpoint is needed. |
| Rate limiting on forgot-password | Without it, the endpoint can be used to exhaust email quota by submitting valid emails in bulk. Redis-backed rate limiting is the right solution (Redis is already in stack). Not implemented yet. |
| Account lockout after failed logins | No brute-force protection on the login endpoint. Rate limiting at the infrastructure level (API gateway / reverse proxy) is assumed. |
| Audit logging | State-changing operations (login, logout, password reset) do not write to a dedicated audit table yet. Planned as a cross-cutting concern. |
| OAuth / SSO | Not in scope. Would require an ADR. |

---

## API Reference

| Method | Path | Auth required | Permission | Description |
|---|---|---|---|---|
| POST | `/auth/login` | No | — | Authenticate and receive session token |
| DELETE | `/auth/logout` | Yes (Bearer) | — | Invalidate current session |
| POST | `/auth/forgot-password` | No | — | Request password reset email |
| POST | `/auth/reset-password` | No | — | Set new password using reset token |

---

## Constraints and Assumptions

- **Email is globally unique** across all tenants. A user cannot belong to multiple tenants. This is a deliberate constraint — multi-tenant membership would require a significant schema change.
- **Roles are fixed** at the platform level. Tenants cannot define custom roles. Adding a new role requires a schema migration and a code change to the permission matrix.
- **Session TTL is not configurable** per tenant or per user. It is a platform constant (8 hours). Changing it requires a code deploy.
- **Email provider is Resend.** If Resend is unavailable and retries are exhausted, the user cannot receive a reset email until the provider recovers or a new token is requested.
- **No password history enforcement.** A user can reset their password to a previously used password.

---

## Acceptance Criteria

### Login
- [ ] Valid credentials return `200` with a token, user object, and tenant object.
- [ ] Wrong password returns `401` with no indication of which field is wrong.
- [ ] Unknown email returns `401` with identical error to wrong password.
- [ ] Inactive user returns `401`.
- [ ] Inactive tenant returns `401`.
- [ ] Missing request fields return `422`.

### Logout
- [ ] Valid token returns `204`.
- [ ] Using the same token again after logout returns `401`.
- [ ] Missing token returns `401`.

### Forgot Password
- [ ] Valid email returns `200` and creates a `PasswordResetToken` row.
- [ ] Unknown email returns `200` and creates no token row.
- [ ] Invalid email format returns `422`.

### Reset Password
- [ ] Valid token and new password returns `200`.
- [ ] After reset, login with new password succeeds.
- [ ] After reset, login with old password fails.
- [ ] All pre-reset sessions are invalidated (requests with old session tokens return `401`).
- [ ] Expired token returns `401`.
- [ ] Already-used token returns `401`.
- [ ] Unknown token returns `401`.
- [ ] Missing fields return `422`.
- [ ] Token is marked `usedAt` after use and cannot be reused even if not yet expired.
