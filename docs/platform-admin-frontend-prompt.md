# Frontend Build Prompt — Platform Admin (Superadmin) Console

> Hand the section below to your frontend app/agent. It is self-contained. Backend reference: `docs/platform-admin.md`.

---

## Prompt

Build a **Platform Admin Console** — a small, standalone web app for platform operators (superadmins) to provision and manage tenants of our multi-tenant ERP. It is **separate** from the tenant-facing app and talks to the backend's `/platform/*` API. Match our existing frontend stack and conventions; if none exists, use a modern SPA framework with typed API calls.

### Authentication — passwordless magic link

There are **no passwords**. The flow is:

1. **Login page** (`/platform/login`): single email input. On submit, `POST /platform/auth/request-link` with `{ email }`. The response is **always `200`** (it never reveals whether the email is a real admin). Show a neutral confirmation: *"If that email belongs to an admin, a sign-in link is on its way."* Do not indicate success/failure of the lookup.

2. **Verify page** (`/platform/verify`): the emailed link lands here as `/platform/verify?token=<token>`. On load, read `token` from the query string and `POST /platform/auth/verify` with `{ token }`.
   - `200 { token }` → store the session token and redirect to the dashboard.
   - `401` → show *"This sign-in link is invalid or expired"* with a button back to the login page.
   - If no `token` query param is present, redirect to login.

3. **Session token**: send it as `Authorization: Bearer <token>` on every authenticated request. Sessions last ~8 hours. There is **no logout endpoint** — "Log out" simply discards the stored token client-side and returns to the login page.

4. **401 handling**: any authenticated request returning `401` means the session is gone/expired — clear the token and redirect to login.

### Screens

1. **Login** — email entry (above).
2. **Verify** — token exchange (above), with a loading state.
3. **Tenants dashboard** (`/platform/tenants`, auth-gated): `GET /platform/tenants`. Render a table of tenants: name, slug, plan, status (Active/Suspended badge from `isActive`), created date (`createdAt` is ISO-8601). Include a "New tenant" button and a per-row suspend/reactivate action.
4. **Create tenant** (modal or page): form fields —
   - Tenant **name** (free text), tenant **slug** (must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, max 63 — validate client-side and lowercase as the user types),
   - First admin **email** and **name**.
   Submit `POST /platform/tenants` with `{ tenant: { name, slug }, admin: { email, name } }` and a fresh `Idempotency-Key` header (a UUID generated per submit; reuse the same one if the user retries the same submission). On `201`, close and refresh the list, and surface a note that *the new admin has been emailed a link to set their password*. On `409` (`TENANT_SLUG_TAKEN`), show a field-level error on slug. On `422`, show validation errors.
5. **Suspend / reactivate**: `PATCH /platform/tenants/{id}` with `{ isActive: false | true }` where `{id}` is the tenant's `id` (a UUID) from the list. Confirm before suspending. Refresh the row on success.

### API contract

Base path: `/platform`. JSON in/out. Error responses are always `{ "error": { "code": string, "message": string } }`.

| Method & path | Auth | Request | Success | Notable errors |
|---|---|---|---|---|
| `POST /platform/auth/request-link` | no | `{ email }` | `200` (empty) | `422` invalid email |
| `POST /platform/auth/verify` | no | `{ token }` | `200 { token }` | `401` bad/expired/used token |
| `GET /platform/tenants` | yes | — | `200 { tenants: [{ id, slug, name, isActive, plan, createdAt }] }` | `401` |
| `POST /platform/tenants` | yes | `{ tenant: { name, slug }, admin: { email, name } }` | `201 { tenant: { id, slug, name }, admin: { email } }` | `409` slug taken, `422`, `401` |
| `PATCH /platform/tenants/{id}` | yes | `{ isActive }` | `200 { id, slug, name, isActive }` | `404` not found, `401` |

`id` everywhere is a **UUID** (the tenant's public id). Honor `Idempotency-Key` on the two mutations (`POST`/`PATCH`) by sending a per-submit UUID.

### Important constraints

- **The `/platform/*` API is IP-allowlisted and returns `404` to non-allowlisted clients.** This means the console (and the browser's actual egress IP, or your dev proxy) must be on the allowlist, or *every* call — including login — returns `404`. Treat an unexpected `404` on `request-link`/`verify` as *"this network isn't permitted"* and show a clear message rather than a generic error. In local dev the backend allows loopback (`127.0.0.1`), so run the frontend through a dev proxy to the backend origin, or point API calls at `http://localhost:<port>` directly.
- **A `404` on `PATCH` is ambiguous** between "tenant not found" and "IP blocked" — only treat it as "not found" if other authenticated calls in the session are succeeding.
- The tenant admin's **"set your password"** page is part of the *tenant* app (`/reset-password?token=...`), not this console. The console only triggers it by creating the tenant.

### UX notes

- Keep it minimal and operator-focused: a login, a tenant table, a create form, a suspend toggle.
- Show clear, non-enumerating messaging on login.
- Disable the create-submit button while in flight; reuse the same `Idempotency-Key` for an in-place retry of the same form.
- Status badges: green "Active" / grey "Suspended".

---
