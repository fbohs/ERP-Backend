# Audit Logging — Why It Lives in Postgres (OLTP), Not an OLAP Store

## Overview

Audit logging in this ERP backend is governed by two binding rules:

- **Hard rule #7** (`CLAUDE.md`): *State-changing endpoints write an audit row in the same transaction as the change.*
- **Engineering charter §8**: schema `audit_log(id, tenant_id, actor_id, entity_type, entity_id, action, before, after, request_id, occurred_at)`, and *"audit writes share the transaction with the operation. If the operation rolls back, the audit row does too."*

The recurring question is: audit data is append-only, time-series, queried in aggregate, and grows forever — that *looks* like an OLAP workload, so why not write it to ClickHouse / BigQuery / Snowflake instead of a Postgres table?

The short answer: **the audit row is part of the transaction. OLAP stores cannot join a Postgres transaction, so they cannot be the write target.** The correct place for an analytical store is *downstream* of the Postgres table, not in place of it.

---

## The binding constraint: transactional consistency

The audit row and the business operation must commit or roll back **atomically**. This is not a performance preference — it is a correctness invariant.

If the two can diverge, you get one of two corruption modes:

1. **Operation commits, audit write fails** → a change happened with no record of it. The audit trail is silently incomplete.
2. **Audit write commits, operation rolls back** → the audit trail claims something happened that never did. A phantom entry.

For an ERP — where the mission statement explicitly says *"audit trails are legally meaningful"* — both modes are unacceptable. The audit log is evidence. Evidence that can be wrong is worse than no evidence, because it is trusted.

The only mechanism that guarantees atomicity here is a **single database transaction**. That means the audit row must be written into the *same database* as the operation. There is no distributed transaction between Postgres and an OLAP engine — and even where two-phase commit exists, it is fragile operational surface we are not taking on.

So: `audit_log` is a table in the same Postgres instance as the business tables. The write is `INSERT INTO audit_log ...` inside the service's existing `db.transaction()`.

---

## Why "audit data is analytical" is true but doesn't change the answer

The instinct is correct. Audit data *is* analytical in shape:

- append-only (rows are never updated or deleted in normal operation)
- time-series (every row has `occurred_at`)
- queried in aggregate ("all changes to entity X", "everything actor Y did last quarter", "all `delete` actions across the tenant")
- unbounded growth

But "what shape is the data" and "where must the write land" are two different questions. The *write* is bound to the OLTP transaction. The *analytical read pattern* is a reason to eventually add an OLAP layer — **downstream**, fed asynchronously, never as the transactional target.

### The correct two-tier pattern

```
business operation ──┐
                     ├── single Postgres transaction ──> audit_log (system of record)
audit row write ─────┘
                                                              │
                                                              │  async: CDC / logical
                                                              │  replication / export job
                                                              ▼
                                                    OLAP store (analytical sink)
                                                    - long-term retention
                                                    - aggregate reporting
                                                    - cheap cold storage
```

- **Tier 1 — Postgres `audit_log`**: the transactionally consistent, legally-meaningful system of record. Written in the operation's transaction.
- **Tier 2 — OLAP store (optional, future)**: rows shipped downstream after commit. Once safely landed in the OLAP store, the Postgres side can be pruned or partition-dropped to keep the hot table small.

The OLAP layer *complements* the table; it never *replaces* it.

---

## Data volume — why OLAP is premature here anyway

OLAP engines exist to solve a volume problem. It is worth checking whether this system actually has that problem before reaching for one.

Audit events here are **business mutations**: an order created, an inventory level adjusted, a purchase order approved, a user logging in. This is human- and process-paced data. It is not clickstream, telemetry, or IoT data — the volumes that justify ClickHouse are typically millions to billions of rows per day from machine-generated events.

A **partitioned Postgres table** (e.g. monthly range partitions on `occurred_at`, indexed on `(tenant_id, entity_type, entity_id)` and `(tenant_id, occurred_at)`) handles years of ERP audit history comfortably. Old partitions can be detached and archived cheaply.

Reaching for an OLAP database now would be premature optimization: real operational cost (a new datastore, new infra, new failure modes, ETL plumbing) against a volume problem that does not yet exist. Adding it later is a clean, additive change — the `audit_log` table stays exactly as it is and simply gains a downstream consumer.

Note also: an OLAP database is **outside the locked stack**, so adopting one is an explicit `/adr` decision — not something to fold into a feature branch.

---

## Approaches that do not work — and why

Each of these is a tempting "lighter" alternative. Each one breaks the transactional-consistency invariant.

### ❌ Log to Pino / stdout / a log aggregator

Emitting the audit record as a structured log line is not transactional. The line is written to the process's output the moment the code runs — there is no rollback. If the surrounding DB transaction then rolls back, the log says an operation happened that did not. The log pipeline is also lossy by design (buffering, sampling, dropped lines under pressure), which is the opposite of what a legal record needs.

### ❌ Enqueue a BullMQ job to write the audit row

The job is enqueued from application code, not from the database transaction. Two failure windows open up:

- enqueue succeeds, transaction rolls back → phantom audit entry
- transaction commits, enqueue fails (Redis blip) → missing audit entry

The job also runs *later*, so there is a window where a committed operation has no audit row at all. Async queues are the right tool for the *OLAP shipping* step (tier 2), where eventual consistency is fine — they are the wrong tool for the system-of-record write.

### ❌ Write directly to an OLAP store (ClickHouse / BigQuery / Snowflake)

This is the original question. No shared transaction with Postgres exists, so the audit write and the business operation can diverge in either direction. OLAP engines are also tuned for batch ingestion and have weak or non-existent single-row transactional semantics — they are built for analytical reads, not transactional writes. Correct as a *sink*, wrong as the *target*.

### ❌ Postgres triggers that auto-populate `audit_log`

This one at least keeps the write in Postgres and in-transaction, so it satisfies atomicity. But it fails on other grounds:

- Triggers cannot see request-scoped context — `actor_id` and `request_id` are not visible to the database without smuggling them through session variables (`SET LOCAL`), which is exactly the kind of implicit, magic data flow the charter tells us to reject in favour of explicit.
- Trigger logic is invisible from the application code; it is hidden control flow that the layered architecture (routes → services → repositories) is designed to avoid.

The audit write should be an explicit line in the service, passed the executor like any other repository call.

### ❌ Reuse an existing table

There is no table in the current schema whose shape or semantics fit a generic audit record. Overloading one would be worse than a dedicated table.

---

## Summary

| Question | Answer |
|---|---|
| Does audit logging need a new table? | Yes — `audit_log` in Postgres. The same-transaction rule forces it. |
| Isn't audit data an OLAP workload? | In *shape*, yes. But the *write* is bound to the OLTP transaction; OLAP is a downstream sink, not the target. |
| Should we add an OLAP store now? | No. ERP audit volume is business-paced, not machine-paced; a partitioned Postgres table is sufficient for years. Revisit via `/adr` if volume demands it. |
| Why not just log it / queue it? | Both are non-transactional. They allow the audit trail to diverge from reality — unacceptable for a legally-meaningful record. |
| Why not Postgres triggers? | Transactional, but cannot see `actor_id` / `request_id` without implicit magic, and hide control flow from the service layer. |

The decision is therefore stable regardless of future OLAP plans: **the Postgres `audit_log` table must exist**, written inside each state-changing operation's transaction. An OLAP analytical layer is a separate, additive, ADR-gated decision that sits downstream of it.
