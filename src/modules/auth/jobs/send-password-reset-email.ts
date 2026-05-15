import { Queue } from 'bullmq';

export const PASSWORD_RESET_EMAIL_QUEUE = 'auth.password-reset-email';

export interface PasswordResetEmailPayload {
  email: string;
  name: string;
  resetUrl: string;
}

export type PasswordResetEmailQueue = Queue<PasswordResetEmailPayload>;

export function createPasswordResetEmailQueue(redisUrl: string): PasswordResetEmailQueue {
  const url = new URL(redisUrl);
  return new Queue<PasswordResetEmailPayload>(PASSWORD_RESET_EMAIL_QUEUE, {
    connection: {
      host: url.hostname,
      port: Number(url.port) || 6379,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });
}

export async function enqueuePasswordResetEmail(
  queue: PasswordResetEmailQueue,
  token: string,
  payload: PasswordResetEmailPayload,
): Promise<void> {
  // jobId is deterministic on the token — prevents duplicate emails if the
  // endpoint is called twice before the first job runs
  await queue.add('send', payload, { jobId: `password-reset.${token}` });
}
