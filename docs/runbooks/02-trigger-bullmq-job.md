# Runbook: Manually Trigger a BullMQ Job

> Re-enqueue a failed job or force a job without going through the HTTP flow.

---

## When to run

- A job is stuck in `failed` state and needs an immediate retry outside the automatic retry schedule.
- You need to test a worker in staging without going through the full API flow.

---

## Queue names

| Constant | String name |
|---|---|
| `PASSWORD_RESET_EMAIL_QUEUE` | `password-reset-email` |
| `PLATFORM_LOGIN_EMAIL_QUEUE` | `platform-login-email` |
| `TENANT_WELCOME_EMAIL_QUEUE` | `tenant-welcome-email` |
| `USER_WELCOME_EMAIL_QUEUE` | `user-welcome-email` |

---

## Option A — Bull Board UI (preferred for production)

1. Ensure your IP is in `PLATFORM_IP_ALLOWLIST`.
2. Open `https://<your-app>/platform/queues` in a browser.
3. Navigate to the relevant queue.
4. Find the failed job. Click **Retry**.

Expected: job moves from `failed` → `active` → `completed`. Check application logs to confirm the Resend call was made.

---

## Option B — one-off script (staging / dev only)

Write a minimal script, run it once, then delete it — do not commit it.

```ts
import { Queue } from 'bullmq';
import { connectionFor } from '../src/shared/queue/connection.js';

const connection = connectionFor(process.env['QUEUE_REDIS_URL']!);
const queue = new Queue('password-reset-email', { connection });

await queue.add(
  'manual',
  {
    email: 'user@example.com',
    name: 'Test User',
    resetUrl: 'https://app.example.com/reset?token=abc123',
  },
  { jobId: `manual-${Date.now()}` },
);

await queue.close();
```

```bash
QUEUE_REDIS_URL=<url> node --import tsx/esm scripts/trigger-job-once.ts
```

Adapt the payload shape to match the target queue. Each queue's payload type is defined alongside its queue constant (e.g. `PasswordResetEmailPayload` in `src/modules/auth/jobs/send-password-reset-email.ts`).

---

## What can go wrong

**Job stuck in `waiting`, never moves to `active`.**
Workers are not running. Check that the app is up and `RESEND_API_KEY` is set — workers are skipped at startup when the key is absent.

**Job repeatedly fails.**
Check the Resend API key scope vs. `EMAIL_FROM` domain. Resend silently accepts sends that don't match — see `docs/known-issues.md`.

**Duplicate job is a no-op.**
Each queue uses deterministic `jobId`s. Providing the same `jobId` twice does nothing — the second add is silently ignored. Use a different `jobId` if you actually want a second job.
