---
name: add-bullmq-job
description: Use when adding background or asynchronous work — sending notifications, generating reports, processing webhooks, batch operations, scheduled tasks, or anything that should outlive the HTTP request. Triggered by "add a job", "process in background", "queue this", "send async", "schedule X", or similar phrasing. Covers idempotency, the outbox pattern for cross-boundary writes, retry policy, and worker-process separation.
---

# Add a BullMQ Background Job

> Use when adding asynchronous work: sending notifications, generating reports, processing webhooks, batch operations. Triggered by "add a job", "process in background", "queue this", or anything where work should outlive the HTTP request.

## Decision Check

Before adding a job, ask:

- **Is it cross-boundary** (DB write + external API call, or DB write + email)? Then it belongs in a job, dispatched via the **outbox pattern**.
- **Is it just slow** (a heavy report)? Job is fine, but consider whether streaming or pagination would be better UX.
- **Does it need to be transactional with a DB write?** Then absolutely outbox — never enqueue inside a transaction directly.

## Structure

```
src/modules/<domain>/jobs/
  <job-name>.job.ts      # the processor function + payload type
  <job-name>.queue.ts    # queue definition + typed producer
```

## Payload Discipline

- **Versioned payloads**: every payload starts with `{ v: 1, ... }`. When the shape changes, bump the version; workers handle old versions during rolling deploys.
- **Minimal data**: pass IDs, not full entities. The worker re-fetches what it needs. Old snapshots in queue payloads cause subtle bugs.
- **Typed**: payload type lives next to the processor, validated with Zod on entry to the worker.

```ts
// invoice-send-receipt.job.ts
import { z } from 'zod';

export const InvoiceSendReceiptPayload = z.object({
  v: z.literal(1),
  tenantId: z.string().uuid(),
  invoiceId: z.string().uuid(),
});
export type InvoiceSendReceiptPayload = z.infer<typeof InvoiceSendReceiptPayload>;

export async function processInvoiceSendReceipt(
  payload: InvoiceSendReceiptPayload,
  deps: { invoiceRepo: InvoiceReader; mailer: Mailer; clock: Clock },
): Promise<void> {
  const parsed = InvoiceSendReceiptPayload.parse(payload);
  // ... idempotent body
}
```

## Idempotency

**Every job must be idempotent.** Either:

1. **Deterministic `jobId`** so duplicate enqueues are no-ops: `${eventType}-${entityId}-${eventInstance}`. BullMQ dedupes on `jobId`.
2. **Side-effect check at the start** of the processor: read state, return early if already done.

Pattern 1 is cheaper. Pattern 2 is more defensive. Critical money-moving jobs use both.

## The Outbox Pattern (Cross-Boundary Writes)

When a DB write must trigger a job:

```ts
await db.transaction().execute(async (tx) => {
  // 1. Business write
  await invoiceRepo.withTx(tx).markPaid(tenantId, invoiceId, payment);

  // 2. Outbox write — SAME transaction
  await outboxRepo.withTx(tx).insert({
    id: crypto.randomUUID(),
    type: 'invoice.send-receipt',
    payload: { v: 1, tenantId, invoiceId },
  });
});
// 3. A relay worker (separate process) reads outbox rows and enqueues to BullMQ,
//    marking them 'dispatched'. This survives "DB committed, queue enqueue failed".
```

**Never enqueue directly inside a transaction.** If the transaction rolls back, you'd have a ghost job referencing a row that doesn't exist.

## Retries, Backoff, DLQ

Declared on the queue, reviewed in code review:

```ts
const queue = new Queue('invoice-send-receipt', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: false, // keep failures for inspection
  },
});
```

After max attempts, jobs land in a **dead-letter queue** and trigger an alert. They are not silently dropped.

## Workers Run in a Separate Process

`src/workers/index.ts` boots workers. **Never** start a worker inside the HTTP process in production — queue backpressure will starve HTTP.

## Tests

- Unit test the processor function with fake dependencies. Assert idempotency by calling it twice with the same payload and verifying one side effect.
- Integration test the outbox → relay → worker path with Testcontainers Postgres + Redis.

## Checklist

- [ ] Payload has `v: 1` and is Zod-validated on entry.
- [ ] Payload contains only IDs/refs, not snapshots of mutable state.
- [ ] Job is idempotent (deterministic `jobId` and/or state check).
- [ ] Cross-boundary writes go through the outbox table.
- [ ] Retry/backoff/DLQ explicitly configured.
- [ ] Worker is registered in `src/workers/index.ts`, not in the HTTP process.
- [ ] Tests cover happy path + double-invocation + final-attempt-failure paths.
