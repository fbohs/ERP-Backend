# Auth Timing Side-Channels — Login & Forgot-Password

## Overview

Two auth endpoints leaked, through *response time*, information they were careful never to leak through the response *body*. Both have now been addressed in `auth.service.ts`. This note records the attack, the fixes, and — importantly — the limits of one of those fixes.

A **timing side-channel** (or timing oracle) is when the duration of a response, rather than its content, tells the attacker something. Two requests can return the byte-identical `401 Invalid credentials` and still be distinguishable if one consistently takes 80ms and the other 1ms.

---

## 1. Login — user enumeration via early return

### The bug

The original `login` flow:

```
findUserByEmail()                          ~1ms   (one indexed SELECT)
  └─ no user?  → throw 401  ───────────────┐      returns here, fast
argon2.verify(user.password, password)     ~60ms  │  only reached if user exists
  └─ no match? → throw 401                 ┘      returns here, slow
```

`argon2.verify` is *deliberately* expensive — that is the whole point of a password hash. So:

- **Unknown email** → response in ~1ms (DB lookup only).
- **Known email, wrong password** → response in ~60ms (DB lookup + full argon2 verify).

The error message is identical in both cases, but the **timing is not**. An attacker scripting login attempts and measuring latency can sort any email list into "has an account here" and "doesn't" — without ever guessing a password. For a multi-tenant ERP, the account list is itself sensitive (it reveals which companies are customers, who works where).

### The fix — always do the work

```ts
const passwordMatches = await argon2.verify(
  user?.password ?? DECOY_PASSWORD_HASH,
  password,
);
if (!user || !user.isActive || !user.tenantIsActive || !passwordMatches) {
  throw new UnauthorizedError('Invalid credentials');
}
```

`DECOY_PASSWORD_HASH` is a module constant: a precomputed `argon2id` hash of a random string, generated with the same default parameters `argon2.hash()` uses elsewhere. When there is no user, the submitted password is verified *against the decoy* instead of being short-circuited. The verify always runs, always costs ~60ms, and the result for a non-existent user is always `false` (the attacker's password will not match a hash of random bytes).

Result: the CPU spent is independent of whether the email exists. The timing channel is **closed**, not merely narrowed — argon2 verification dominates the request cost so completely that the residual variation (a present vs. absent DB row) is lost in the noise.

Why a *constant* and not hashing something on the fly: generating a fresh decoy per request would itself cost an `argon2.hash` (~60ms) on top of the verify, doubling login latency for no benefit. One precomputed constant is enough.

---

## 2. Forgot-password — enumeration via "did work / did nothing"

### The bug

`forgot-password` was already careful in one dimension: it returns `200` regardless of whether the email exists, so the *body* never enumerates. But the original flow still branched on existence:

```
findUserByEmail()
  └─ no user?  → return immediately  ──────────  nothing happens
create token, open transaction (2 inserts), enqueue email  ──  real work, several ms
```

Unknown email → near-instant. Known email → a DB transaction plus a queue write. Same `200`, different duration. A weaker oracle than the login one (the delta is a few milliseconds, not ~60), but a real one.

### The fix — and its honest limit

```ts
const account = user !== undefined && user.isActive && user.tenantIsActive ? user : null;
const token = crypto.randomBytes(32).toString('hex');     // computed unconditionally
const expiresAt = new Date(...);                          // computed unconditionally

await this.db.transaction().execute(async (tx) => {
  if (account === null) {
    return;                                               // BEGIN … COMMIT, no writes
  }
  await this.repo.withTx(tx).createPasswordResetToken(...);
  await this.audit.withTx(tx).record({ ... });
});
```

The token, the expiry, and **a database transaction** are now produced for *every* request. The dominant constant cost — opening and committing a transaction (the `BEGIN`/`COMMIT` round-trips) — happens either way.

**This is a mitigation, not an elimination.** Be honest about the residual:

- The known-email path still does two `INSERT`s inside the transaction; the unknown-email path does none. That is roughly two extra statement round-trips — single-digit milliseconds.
- The known-email path additionally enqueues a BullMQ job (a Redis round-trip); the unknown path does not.

Closing those completely would require the unknown-email path to perform *fake* inserts and a *fake* enqueue — deliberately writing throwaway rows and jobs purely to burn matching time. That is fragile (the fake work has to be kept in sync with the real work forever) and is itself a code smell. We judged it not worth it, because:

1. The residual delta is small and **noisy** — a few milliseconds, swamped by network jitter. Extracting signal from it needs many samples per email.
2. The complementary defense — **rate limiting on `forgot-password`** — directly attacks the attacker's ability to *collect* those samples. Timing attacks need volume; rate limiting denies volume. (Rate limiting is tracked separately and is the more important of the two controls here.)

So the disposition for forgot-password is: gross timing leak removed, residual leak accepted and bounded, real defense delegated to rate limiting.

---

## Why there are no timing unit tests

Neither fix is covered by a timing assertion, and that is deliberate. Asserting "response A is within Xms of response B" is inherently flaky — it depends on CI machine load, GC pauses, and Postgres warm-up. Such tests fail randomly and get muted, which is worse than not having them.

What *is* tested is that behaviour is unchanged: login still returns `401` for unknown emails, wrong passwords, and inactive users; forgot-password still returns `200` in every case. The timing properties are an argument about the code's *structure* — "the verify always runs", "a transaction always opens" — verifiable by reading `auth.service.ts`, not by a stopwatch in CI.

---

## Summary

| Endpoint | Leak | Fix | Fully closed? |
|---|---|---|---|
| `login` | ~60ms argon2 skipped when user absent | Verify against `DECOY_PASSWORD_HASH` when absent | Yes — argon2 cost dominates and is now constant |
| `forgot-password` | DB transaction + enqueue skipped when user absent | Always compute token + open a transaction | Partially — gross leak gone; small residual accepted, backstopped by rate limiting |

General principle: **to avoid leaking *whether* you did something, do the same work either way.** When the work can be made genuinely constant (login's argon2 verify), the channel closes. When it cannot without writing fake side effects (forgot-password's DB writes), narrow it as far as is clean and pair it with a control that limits sampling.
