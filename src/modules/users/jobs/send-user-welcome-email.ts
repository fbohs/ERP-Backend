import { Queue } from 'bullmq';

export const USER_WELCOME_EMAIL_QUEUE = 'users.user-welcome-email';

export interface UserWelcomeEmailPayload {
  email: string;
  name: string;
  role: string;
  tenantName: string;
  temporaryPassword: string;
  loginUrl: string;
}

export type UserWelcomeEmailQueue = Queue<UserWelcomeEmailPayload>;

export function createUserWelcomeEmailQueue(redisUrl: string): UserWelcomeEmailQueue {
  const url = new URL(redisUrl);
  return new Queue<UserWelcomeEmailPayload>(USER_WELCOME_EMAIL_QUEUE, {
    connection: {
      host: url.hostname,
      port: Number(url.port) || 6379,
      ...(url.password ? { password: url.password } : {}),
      ...(url.username ? { username: url.username } : {}),
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });
}

export async function enqueueUserWelcomeEmail(
  queue: UserWelcomeEmailQueue,
  userPublicId: string,
  payload: UserWelcomeEmailPayload,
): Promise<void> {
  // Deterministic jobId on the user's publicId prevents duplicate welcome
  // emails if the create endpoint is retried before the first job runs.
  await queue.add('send', payload, { jobId: `user-welcome.${userPublicId}` });
}
