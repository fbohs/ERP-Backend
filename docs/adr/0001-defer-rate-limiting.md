# 0001 — Defer Rate Limiting to a Dedicated Branch

**Status:** Proposed
**Date:** 2026-05-15
**Deciders:** Madhusudansingh Rathore

## Context

Review of `feature/auth_flow` found that no auth endpoint is rate limited. Three endpoints carry real exposure without it:

- `POST /auth/login` — password spraying and credential stuffing.
- `POST /auth/forgot-password` — account enumeration (the timing channel is only partially closed; see `learnings/technical/auth-timing-attacks.md`) and reset-email flooding of a victim's inbox.
- `POST /auth/reset-password` — brute force against reset tokens.

Rate limiting is not an auth concern — it is cross-cutting infrastructure. Once it exists it will apply to most mutating and expensive endpoints across every module (accounting, inventory, purchasing, …). Building it inside the auth branch risks a design shaped only by auth's needs.

Two implementation paths were on the table and neither is trivially correct: a hand-built Redis-backed limiter in `src/shared/`, or the `@fastify/rate-limit` plugin (which introduces a runtime dependency outside the locked stack).

## Decision

Rate limiting is **not** implemented in `feature/auth_flow`. It is delivered in a dedicated follow-up branch, built once as shared infrastructure under `src/shared/` and applied across endpoint families — not added per-endpoint, ad hoc, inside feature branches.

Until that branch lands, auth endpoints ship without rate limiting and the residual enumeration / brute-force / flooding exposure is **accepted** for this branch.

## Consequences

- **Easier:** the auth branch stays scoped to auth. Rate limiting gets designed holistically — consistent limits, `Retry-After` headers, a shared store, bypass rules for internal traffic — instead of piecemeal per branch.
- **Harder / risk:** between merging this branch and the rate-limiting branch, the auth endpoints are exposed. Partial mitigations are already in place and reduce (do not remove) that exposure:
  - uniform responses regardless of account existence (`forgot-password` always `200`, `login` always the same `401`);
  - the decoy-hash timing fix on `login` and the always-open-a-transaction mitigation on `forgot-password`;
  - reset tokens are single-use and, as of this branch, single-live (issuing a new one invalidates prior unused tokens);
  - opaque session and reset tokens carry 32 bytes of entropy, making blind brute force impractical.
- **New constraint:** the follow-up branch must decide custom-vs-`@fastify/rate-limit`. If it adds a dependency, that decision needs its own ADR.

## Alternatives Considered

- **Custom Redis-backed limiter now, in this branch.** Rejected: it is a meaningful amount of code and tests, and building it against auth's needs alone risks a design that does not generalize to the rest of the system.
- **`@fastify/rate-limit` + a dependency ADR now.** Rejected: adding a runtime dependency should not be rushed inside an auth PR. The plugin-vs-custom choice deserves a deliberate evaluation in the branch that owns the work.
- Both were deferred rather than chosen, so the follow-up branch can pick deliberately.

## References

- Related ADRs: none
- `learnings/technical/auth-timing-attacks.md` — names rate limiting as the real defense for `forgot-password` enumeration
- Branch: `feature/auth_flow`
