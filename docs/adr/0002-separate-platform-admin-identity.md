# 0002 — Model the Superadmin as a Separate, Passwordless Platform Identity

**Status:** Proposed
**Date:** 2026-05-25
**Deciders:** Madhusudansingh Rathore

## Context

The system needs a superadmin: an operator who provisions tenants, creates each tenant's first `ADMIN` user, suspends or reactivates tenants, and (later) owns subscription/billing. None of this exists today.

Two facts about the current design frame the decision:

- **Every principal belongs to exactly one tenant.** `User.tenantId` is non-null, `request.user` is `{ userId, tenantId, role }`, and the `UserRole` enum (`ADMIN … VIEWER`) is entirely *in-tenant* — `ADMIN` means "all permissions, within one tenant." The charter makes "every business-table query is tenant-scoped" a **P0** invariant. A superadmin is the opposite: a cross-tenant platform operator.
- **There is no tenant- or user-creation path at all.** `auth.routes.ts` is only login / logout / forgot-password / reset-password. Tenants and users can presently appear only via manual SQL or Prisma Studio. Building the superadmin surface *is* building the tenant-onboarding mechanism — they are the same task.

The tension is reconciling a cross-tenant operator with the single-tenant principal assumption without opening a hole in the P0 invariant. Three identity shapes were considered (see Alternatives). Payment/billing is platform-level and naturally belongs to the same operator, but is **out of scope** for this ADR; `Tenant.plan` remains the placeholder.

The superadmin population is tiny and trusted (platform operators, not self-serve customers). That makes a passwordless, email-possession-based credential preferable to a stored password: fewer secrets to protect, no reset sub-flow, nothing to phish or reuse.

## Decision

The platform-operator identity is modeled **separately from tenant users**, not as a role on the existing `User` table, and it authenticates **passwordlessly via a single-use email magic link**.

- New `PlatformAdmin` and `PlatformAdminSession` tables, with **no `tenantId`** column and **no `password` column**. `SUPER_ADMIN` is **not** added to `UserRole`. A `PlatformAdmin` is `{ publicId, email (unique), name, isActive, timestamps }`.
- New `PlatformAdminLoginToken` table mirroring the existing `PasswordResetToken` pattern (single-use, short TTL, single-live — issuing a new token supersedes prior unused ones for that admin).
- A separate `/platform/*` HTTP surface with its own authenticate middleware, setting `request.platformAdmin = { adminId }`. The tenant-facing app never sees a platform principal, and `request.user` is never a superadmin. Login is two steps:
  - `POST /platform/auth/request-link` `{ email }` — generate a 32-byte token (`crypto.randomBytes(32)`, same entropy as session/reset tokens), persist it via `PlatformAdminLoginToken`, supersede prior unused tokens, and enqueue a login email containing the link. **Always responds `200`** regardless of whether the email is a known admin (enumeration defense, mirroring `forgot-password`).
  - `POST /platform/auth/verify` `{ token }` — look the token up; reject if missing, expired, or already consumed; on success create a `PlatformAdminSession`, return the session token, and consume the login token.
- The entire `/platform/*` surface sits behind an **IP allowlist**, enforced as the *first* preHandler on every platform route — ahead of authentication. The allowlist is sourced from typed config (`PLATFORM_IP_ALLOWLIST`), supporting exact IPv4/IPv6 addresses and IPv4 CIDR ranges via hand-rolled matching (≈20 lines, no new dependency; IPv6 entries match exactly). It is **fail-closed**: an empty or unset allowlist denies every request, so the surface is never accidentally world-reachable. The dev `.env.local` ships with loopback (`127.0.0.1`, `::1`). A request from a non-allowlisted IP receives `404` (not `403`) so the surface's existence is not disclosed to scanners. Client IP is read from `request.ip`, which requires Fastify `trustProxy` (configured from config) to match the deployment's proxy topology — otherwise the check sees the proxy's IP or trusts a spoofable `X-Forwarded-For`.
- Cross-tenant operations (create tenant + first admin, list tenants, suspend/reactivate) live in a **platform repository**, distinct from business repositories. Business repositories keep their mandatory `tenantId` parameter unchanged — there is no "skip the tenant filter" path anywhere.
- `AuditLog` gains an `actorType` column (`'USER'` default, `'PLATFORM_ADMIN'`) so platform actions are attributable and never confused with a tenant user, since `actorId` alone cannot distinguish the two id-spaces.
- The first platform admin is created by an **idempotent CLI run as a release step**, capturing **only an email** (and name). There is no self-registration endpoint and no password prompt.

## Consequences

- **Easier / security posture:** the P0 "every business query is tenant-scoped" invariant stays *literally* true — the cross-tenant surface is a different identity, a different repository, and a different route prefix, so no unscoped path exists in business repositories. No password is stored for the platform identity: no password column, no argon2, no admin password-reset sub-flow, nothing to leak, phish, or reuse. The login credential is ephemeral, single-use, per-login, and carries 32 bytes of entropy. Blast radius is contained — a bug in tenant RBAC cannot escalate across tenants, and a bug in platform auth cannot touch a tenant session. Audit attribution stays unambiguous. Tenant onboarding finally has an owner.
- **Harder / cost:** platform login now **depends on email delivery** (Resend + the BullMQ queue) being configured and healthy. The app today treats email as *optional* — password-reset emails are silently disabled when `RESEND_API_KEY` is unset. Platform auth makes email **mandatory**: with it off, no superadmin can log in at all. Deployment must guarantee email for the platform surface, and this operational coupling is new. There is also a parallel auth path (table, session table, Redis cache namespace `platform-session:`, middleware) duplicating some tenant auth machinery, and bootstrapping is an ops step rather than self-serve.
- **New constraints / residual risk:**
  - Rate limiting is deferred (ADR 0001). Brute-forcing a 32-byte token is impractical, so token guessing is a non-issue, but `request-link` can be abused to **flood an admin's inbox**; that flooding exposure is **accepted** until the rate-limiting branch lands, partially mitigated by superseding prior unused tokens. Cross-reference 0001.
  - `request-link` must return a uniform `200` regardless of email existence, to avoid admin-email enumeration.
  - Login tokens are single-use, single-live, and short-TTL; verification is a direct token lookup, consistent with the existing session/reset-token handling.
  - The IP allowlist is **defense-in-depth, not the primary control**: the edge network (load balancer / security group / Cloudflare) remains the first line of defense; the app-layer check is the second. Its correctness depends on `trustProxy` being configured to match the real proxy chain — too strict locks out legitimate operators, too permissive lets `X-Forwarded-For` spoofing bypass the allowlist. An empty allowlist is a full lockout, by design.
  - Platform routes must **never** call a business repository's tenant-scoped methods to bypass scoping; cross-tenant reads belong in the platform repository and must be explicitly commented as intentionally unscoped.
  - Payment/billing (subscription state per tenant) will attach to the `/platform/*` surface in a later ADR; it is deliberately excluded here.

## Alternatives Considered

Identity shape:

- **A — Add `SUPER_ADMIN` to `UserRole`, put the admin in a "system tenant."** Cheapest schema change, reuses all auth machinery. Rejected: it folds a platform concept into the enum that drives *in-tenant* RBAC, leaves a meaningless `tenantId` on the admin, and — most importantly — tempts an `if (SUPER_ADMIN) skip tenant filter` bypass, which is exactly the P0 violation the charter forbids. Largest blast radius.
- **C — Shared `User` identity + `SUPER_ADMIN` role, but every cross-tenant operation takes an explicit target `tenantId` in the request.** Safer than A and lighter than the chosen option. Rejected: it still mixes platform identity into the tenant `User` table and the shared `request.user` shape, and the separation is a convention enforced by reviewers rather than a structural boundary. The chosen option makes the boundary structural.

Credential mechanism (for the chosen separate identity):

- **Password-based login (argon2, like tenant users).** Rejected: storing passwords for a tiny set of trusted operators adds a credential to protect, a reset sub-flow to build, and a phishing/reuse surface — all avoidable when email possession is already the recovery factor.
- **Short numeric OTP code (e.g. 6 digits).** Rejected: ~1,000,000-value space is brute-forceable while rate limiting is deferred (0001); it would need a strict verify-attempt cap and short TTL to be safe. The 32-byte magic-link token sidesteps the entropy problem entirely and reuses the existing `PasswordResetToken` mechanism rather than introducing a new attempt-counter codepath.

## References

- Related ADRs: 0001 (deferred rate limiting / enumeration exposure, same branch `feature/auth_flow`)
- Reuses the `PasswordResetToken` single-use / single-live / short-TTL pattern (`src/modules/auth`, `prisma/schema.prisma`)
- Charter: `docs/engineering-charter.md`; root `CLAUDE.md` "Always-On Hard Rules" §1, §2, §10
- Branch: `feature/auth_flow`
