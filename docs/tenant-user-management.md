# Tenant User Management — Frontend Integration Reference

> Status: implemented on `feature/auth_flow`.
> Actor: **Tenant Admin** (`ADMIN` role). All endpoints under `/users` require a valid tenant session.

---

## Contents

1. [Overview](#1-overview)
2. [Authentication context](#2-authentication-context)
3. [First-login flow for new users](#3-first-login-flow-for-new-users)
4. [Permission model](#4-permission-model)
5. [Role specs — creation-time data requirements](#5-role-specs--creation-time-data-requirements)
6. [API reference](#6-api-reference)
7. [Error reference](#7-error-reference)
8. [UI/UX guidance](#8-uiux-guidance)

---

## 1. Overview

The tenant admin creates, views, suspends, and removes users within their own tenant. Every action is scoped to the admin's tenant — no cross-tenant visibility is possible.

**Roles the admin can assign** (subordinate roles only — `ADMIN` cannot be assigned through this surface):

| Role | Purpose |
|---|---|
| `MERCHANT` | Adds and manages their own products on the platform |
| `PRODUCT_VERIFIER` | Reviews products for compliance, fraud, quality |
| `CONTENT_MANAGER` | Manages product content and SEO metadata |
| `INVENTORY_MANAGER` | Manages stock levels and warehouses |
| `PURCHASING_MANAGER` | Manages purchase orders and suppliers |
| `SALES_MANAGER` | Manages sales orders and pricing |
| `WAREHOUSE_OPERATOR` | Handles physical receiving and shipping tasks |
| `REPORT_VIEWER` | Read-only access to reports |

**Onboarding model:** the admin creates the account; the system emails a temporary password; the new user sets their own password on first login. No manual password handoff required.

---

## 2. Authentication context

All `/users` endpoints require an `Authorization: Bearer <token>` header. The token is obtained from `POST /auth/login`.

```
POST /auth/login
{
  "email": "admin@acme.com",
  "password": "..."
}

→ 200
{
  "requiresPasswordChange": false,
  "token": "<session-token>",
  "user": { "id": "<uuid>", "name": "Admin User", "role": "ADMIN" },
  "tenant": { "id": "<uuid>", "slug": "acme", "name": "Acme Corp" }
}
```

Store the `token` and the `user.role`. Show the user management surface **only when `user.role === "ADMIN"`** — other roles have neither `user:read` nor `user:write` permission and will receive `403` on every `/users` call.

---

## 3. First-login flow for new users

When the admin creates a user, the backend:
1. Generates a random temporary password.
2. Sets `mustChangePassword = true` on the account.
3. Emails the new user their temporary password + a login URL.

The new user's first login requires a password change before a real session is granted:

```
Step 1 — New user submits their temporary credentials:

POST /auth/login
{ "email": "...", "password": "<temp-password>" }

→ 200
{
  "requiresPasswordChange": true,
  "setupToken": "<short-lived-token>"
}

(No session token is returned. The setupToken is valid for
 config.firstLoginSetupTtlSeconds, typically 30 minutes.)


Step 2 — Frontend redirects to the set-password screen and submits:

POST /auth/setup-password
{ "token": "<setupToken>", "newPassword": "<chosen-password>" }

→ 200
{
  "token": "<session-token>",
  "user": { "name": "..." },
  "tenant": { "id": "...", "slug": "...", "name": "..." }
}

(A real session is granted immediately after setup.)
```

**Frontend handling of `requiresPasswordChange: true`:**
- Do **not** store the `setupToken` in localStorage — keep it only in memory or redirect with it as a route param/state.
- Show a "set your password" screen, not a generic error.
- The `setupToken` is single-use. If the user closes the tab, they must log in again to get a fresh one.

---

## 4. Permission model

Each role carries a fixed set of permissions. The frontend should use `user.role` from the login response to gate sections of the UI:

| Role | `user:read` | `user:write` | `product:read/write` | `report:read` | Notes |
|---|---|---|---|---|---|
| `ADMIN` | ✓ | ✓ | ✓ | ✓ | Full access |
| `MERCHANT` | — | — | ✓ | — | Own products only |
| `PRODUCT_VERIFIER` | — | — | ✓ (read+write) | ✓ | Verification actions |
| `CONTENT_MANAGER` | — | — | ✓ | ✓ | |
| `INVENTORY_MANAGER` | — | — | ✓ (read) | ✓ | |
| `PURCHASING_MANAGER` | — | — | ✓ (read) | ✓ | |
| `SALES_MANAGER` | — | — | ✓ (read) | ✓ | |
| `WAREHOUSE_OPERATOR` | — | — | — | — | Inventory + shipping only |
| `REPORT_VIEWER` | — | — | — | ✓ | Reports only |

**Rule:** render the "Users" section in the sidebar/nav only when `role === "ADMIN"`. Do not rely solely on API 403s to hide it — that degrades UX.

---

## 5. Role specs — creation-time data requirements

`specs` is mandatory at creation time. The shape is discriminated by role.

### `MERCHANT`

```json
{
  "merchant": {
    "businessName": "Gadget World Ltd",
    "registrationNumber": "REG-001",
    "address": "1 Market Street, London",
    "phoneNumber": "+441234567890",
    "website": "https://gadgetworld.com"  // optional
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `businessName` | Yes | Legal or trading name |
| `registrationNumber` | Yes | Company or business registration number |
| `address` | Yes | Business address (freeform string) |
| `phoneNumber` | Yes | Business contact number |
| `website` | No | Must be a valid URL if provided |

### `PRODUCT_VERIFIER`

```json
{
  "verifier": {
    "badgeId": "BADGE-042",
    "certificationLevel": "SENIOR",
    "specializations": ["electronics", "apparel"],
    "certifiedUntil": "2027-12-31"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `badgeId` | Yes | Organisation-issued badge or employee ID |
| `certificationLevel` | Yes | One of `JUNIOR`, `SENIOR`, `LEAD` |
| `specializations` | Yes | Non-empty array of domain strings |
| `certifiedUntil` | Yes | `YYYY-MM-DD` format |

### All other roles

Send `"specs": null`. No additional data is needed.

```json
{
  "role": "REPORT_VIEWER",
  "specs": null
}
```

---

## 6. API reference

### Base URL

`/` — no prefix. All endpoints are tenant-scoped via the session token.

### Session header (all endpoints)

```
Authorization: Bearer <session-token>
```

---

### `POST /users` — Create a user

Creates a subordinate user in the admin's tenant. Sends a welcome email with a temporary password.

**Headers**

| Header | Required | Notes |
|---|---|---|
| `Authorization` | Yes | Bearer token |
| `Idempotency-Key` | Recommended | Prevents duplicate users on retried submissions |

**Request body**

```json
{
  "email": "merchant@acme.com",
  "name": "Jane Merchant",
  "role": "MERCHANT",
  "specs": {
    "merchant": {
      "businessName": "Jane's Store",
      "registrationNumber": "UK-12345",
      "address": "2 High Street, Manchester",
      "phoneNumber": "+441619876543"
    }
  }
}
```

**Responses**

`201 Created`
```json
{
  "id": "01926f3b-7a2c-7000-b3d4-5e8f21c3a9d1",
  "email": "merchant@acme.com",
  "role": "MERCHANT"
}
```

`409 Conflict` — email already in use
```json
{ "error": { "code": "EMAIL_ALREADY_TAKEN", "message": "Email '...' is already in use in this tenant" } }
```

`422 Unprocessable Entity` — validation failure (missing field, wrong specs shape, invalid role)
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request body" } }
```

`403 Forbidden` — session is valid but role lacks `user:write`
```json
{ "error": { "code": "FORBIDDEN", "message": "Insufficient permissions" } }
```

`401 Unauthorized` — missing or expired session
```json
{ "error": { "code": "UNAUTHORIZED", "message": "..." } }
```

**Idempotency note:** if you submit the same `Idempotency-Key` twice, the second call returns the stored 201 response without creating a second user. Use a UUID or random hex per form submission. Reusing the same key with different body returns `409`.

---

### `GET /users` — List users

Returns all users in the admin's tenant, ordered by creation date (oldest first).

**Responses**

`200 OK`
```json
{
  "users": [
    {
      "id": "01926f3b-7a2c-7000-b3d4-5e8f21c3a9d1",
      "email": "merchant@acme.com",
      "name": "Jane Merchant",
      "role": "MERCHANT",
      "isActive": true,
      "specs": {
        "merchant": {
          "businessName": "Jane's Store",
          "registrationNumber": "UK-12345",
          "address": "2 High Street, Manchester",
          "phoneNumber": "+441619876543"
        }
      },
      "createdAt": "2026-05-27T21:30:00.000Z"
    }
  ]
}
```

The list always includes the admin themselves. `specs` is `null` for roles that don't carry domain metadata.

---

### `GET /users/:id` — Get single user

`:id` is the user's `publicId` UUID (from the list response).

**Responses**

`200 OK` — same shape as a single item from the list

`404 Not Found`
```json
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found" } }
```

`422 Unprocessable Entity` — `:id` is not a valid UUID
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid user id" } }
```

---

### `PATCH /users/:id` — Suspend or reactivate

Toggles `isActive`. Suspending a user does **not** immediately terminate their existing sessions — they expire naturally. If immediate revocation is needed, that is a separate operation (not yet implemented on this surface).

**Headers:** `Idempotency-Key` recommended.

**Request body**
```json
{ "isActive": false }
```

**Responses**

`200 OK` — returns the updated user object (same shape as GET)

`403 Forbidden — CANNOT_MODIFY_SELF`
```json
{ "error": { "code": "CANNOT_MODIFY_SELF", "message": "You cannot suspend or reactivate your own account" } }
```

`404 Not Found` — user does not exist in this tenant

`422 Unprocessable Entity` — missing or invalid body

---

### `DELETE /users/:id` — Soft-delete a user

Sets `isActive = false` permanently. The record is retained for audit purposes. The operation is **not reversible through the API** — use `PATCH` to suspend/reactivate instead.

**Headers:** `Idempotency-Key` recommended.

**Responses**

`204 No Content` — deleted successfully (no body)

`403 Forbidden — CANNOT_MODIFY_SELF`
```json
{ "error": { "code": "CANNOT_MODIFY_SELF", "message": "You cannot delete your own account" } }
```

`404 Not Found` — user does not exist in this tenant

---

## 7. Error reference

All error responses share this shape:

```json
{ "error": { "code": "<ERROR_CODE>", "message": "<human-readable>" } }
```

| HTTP status | `code` | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | No `Authorization` header, expired session, or invalid token |
| 403 | `FORBIDDEN` | Valid session but role lacks the required permission |
| 403 | `CANNOT_MODIFY_SELF` | Admin tried to suspend, reactivate, or delete their own account |
| 404 | `USER_NOT_FOUND` | `:id` is a valid UUID but no user with that id exists in this tenant |
| 409 | `EMAIL_ALREADY_TAKEN` | A user with this email already exists in the tenant |
| 409 | `CONFLICT` | Idempotency key reused with a different request body |
| 422 | `VALIDATION_ERROR` | Missing required field, wrong type, invalid enum value, or specs shape mismatch for role |

**Frontend error handling checklist:**
- `401` → redirect to login and clear stored session token.
- `403 / FORBIDDEN` → the current user's role does not have access; do not show the action to them in future renders.
- `403 / CANNOT_MODIFY_SELF` → show inline: "You cannot perform this action on your own account."
- `404` → show "User not found" — may mean the list is stale; refresh it.
- `409 / EMAIL_ALREADY_TAKEN` → show inline on the email field: "This email is already registered in your organisation."
- `409 / CONFLICT` → idempotency key conflict; generate a new key and let the user resubmit.
- `422` → form validation failed server-side; highlight the relevant field. For specs shape mismatches, this means the specs object for the selected role is incomplete or incorrectly structured.

---

## 8. UI/UX guidance

### 8.1 Access gate

Show the user management section **only to `ADMIN`**. Other roles should not see a "Users" nav item at all. If a non-admin navigates directly to the URL, they will receive `403` — show a "You don't have access to this page" message and redirect to their dashboard.

---

### 8.2 User list page

**Columns to display:** Name, Email, Role (human-readable label), Status (Active / Suspended), Created date.

**Role label mapping for display:**

| `role` value | Display label |
|---|---|
| `MERCHANT` | Merchant |
| `PRODUCT_VERIFIER` | Product Verifier |
| `CONTENT_MANAGER` | Content Manager |
| `INVENTORY_MANAGER` | Inventory Manager |
| `PURCHASING_MANAGER` | Purchasing Manager |
| `SALES_MANAGER` | Sales Manager |
| `WAREHOUSE_OPERATOR` | Warehouse Operator |
| `REPORT_VIEWER` | Report Viewer |
| `ADMIN` | Admin |

**Row actions:**
- **View** — always shown (opens detail / edit panel)
- **Suspend** — shown when `isActive === true` and the row is not the current admin's own account
- **Reactivate** — shown when `isActive === false`
- **Delete** — shown for all rows except the current admin's own account; prompt for confirmation before calling

**Distinguish the admin's own row** (compare `user.id` from login response against `row.id`) and disable / hide destructive actions on it.

---

### 8.3 Create user form

**Step 1 — Basic details**

Fields:
- Email (email input, required)
- Full name (text input, required)
- Role (dropdown, required — show human-readable labels above; never show `ADMIN`)

**Step 2 — Role-specific specs** (shown only when role is `MERCHANT` or `PRODUCT_VERIFIER`; hidden for all other roles)

For `MERCHANT`:
- Business Name (text, required)
- Registration Number (text, required)
- Business Address (text or textarea, required)
- Phone Number (tel input, required)
- Website (url input, optional)

For `PRODUCT_VERIFIER`:
- Badge / Employee ID (text, required)
- Certification Level (dropdown: Junior / Senior / Lead, required)
- Specializations (tag/chip input or multi-select — one or more domain strings, required)
- Certified Until (date picker, required — store as `YYYY-MM-DD`)

For all other roles, send `"specs": null` — do not render a step 2.

**UX recommendations:**
- Generate an `Idempotency-Key` (UUID or random hex) when the form is first rendered. Reuse it on retry so a double-submit or network retry does not create a second account.
- On `201`, show a success banner: "Account created. [Name] will receive an email with their temporary password."
- On `409 / EMAIL_ALREADY_TAKEN`, place the error inline under the email field — do not show a generic toast.

---

### 8.4 Suspend / reactivate flow

- **Suspending:** use an inline toggle or a "Suspend" button. A confirmation dialog is recommended: "Suspend [Name]? They will no longer be able to sign in." No immediate session revocation — existing sessions expire naturally.
- **Reactivating:** can be done inline from the list or from the user detail page. No confirmation needed.
- After a successful `PATCH`, update the row in-place from the `200` response body — no need to refetch the full list.

---

### 8.5 Delete flow

Delete is permanent and irreversible through the API. Always require a confirmation step:

> "Delete [Name]? Their account will be permanently deactivated. This action cannot be undone."

After `204`, remove the row from the list client-side. A deleted user's `isActive` becomes `false` permanently — if they attempt to log in, they will receive `401 Invalid credentials`.

---

### 8.6 New user's first-login experience

Your frontend's login page must handle the `requiresPasswordChange: true` case from `POST /auth/login`. The flow:

```
Login screen
    ↓ POST /auth/login { email, password }
    ↓
if requiresPasswordChange === true
    → Store setupToken in memory (not localStorage)
    → Redirect to /set-password

Set-password screen
    → POST /auth/setup-password { token: setupToken, newPassword }
    → On 200: store real session token, redirect to dashboard
    → On 401: setupToken expired — show "Your setup link has expired. Please log in again."
```

The set-password screen should:
- Be accessible at a dedicated route (e.g. `/set-password`)
- Accept the `setupToken` via in-memory state or route state (not query string, which is logged by servers)
- Enforce password strength client-side before submitting
- Not expose a "back" button that goes back to the login screen with the form still filled

---

### 8.7 Role-aware post-login redirect

After a successful login (or setup-password), redirect based on role:

| Role | Suggested landing page |
|---|---|
| `ADMIN` | Dashboard or `/users` |
| `MERCHANT` | Product list (their own products) |
| `PRODUCT_VERIFIER` | Product verification queue |
| `CONTENT_MANAGER` | Product content editor |
| `INVENTORY_MANAGER` | Inventory overview |
| `PURCHASING_MANAGER` | Purchase orders |
| `SALES_MANAGER` | Sales orders |
| `WAREHOUSE_OPERATOR` | Receiving / shipping tasks |
| `REPORT_VIEWER` | Reports index |

---

### 8.8 Idempotency key strategy

For any state-changing request (`POST /users`, `PATCH /users/:id`, `DELETE /users/:id`), include an `Idempotency-Key` header.

```
Idempotency-Key: <random-hex-or-uuid>
```

**Generation:** one key per user action (button click / form submit). Regenerate on:
- A new form open (not a retry)
- After a successful response
- After a `409 CONFLICT` (key was reused with a different body)

Do **not** regenerate on network errors or 5xx — reuse the same key on retry so the operation is safe to replay.

---

## Appendix: full type shapes

### User object (returned by GET /users, GET /users/:id, PATCH /users/:id)

```typescript
interface User {
  id: string;           // UUID v7 — use this as the :id param in all routes
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  specs: MerchantSpecs | VerifierSpecs | null;
  createdAt: string;    // ISO-8601 UTC
}

type UserRole =
  | 'ADMIN'
  | 'MERCHANT'
  | 'PRODUCT_VERIFIER'
  | 'CONTENT_MANAGER'
  | 'INVENTORY_MANAGER'
  | 'PURCHASING_MANAGER'
  | 'SALES_MANAGER'
  | 'WAREHOUSE_OPERATOR'
  | 'REPORT_VIEWER';

interface MerchantSpecs {
  merchant: {
    businessName: string;
    registrationNumber: string;
    address: string;
    phoneNumber: string;
    website?: string;
  };
}

interface VerifierSpecs {
  verifier: {
    badgeId: string;
    certificationLevel: 'JUNIOR' | 'SENIOR' | 'LEAD';
    specializations: string[];
    certifiedUntil: string; // YYYY-MM-DD
  };
}
```

### Create user request body

```typescript
type CreateUserBody =
  | { role: 'MERCHANT';          email: string; name: string; specs: MerchantSpecs }
  | { role: 'PRODUCT_VERIFIER';  email: string; name: string; specs: VerifierSpecs }
  | { role: 'INVENTORY_MANAGER' | 'PURCHASING_MANAGER' | 'SALES_MANAGER'
           | 'WAREHOUSE_OPERATOR' | 'CONTENT_MANAGER' | 'REPORT_VIEWER';
      email: string; name: string; specs: null }
```
