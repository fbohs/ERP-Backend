import { Queue } from 'bullmq';

export const PLATFORM_LOGIN_EMAIL_QUEUE = 'platform.login-link-email';

export interface PlatformLoginEmailPayload {
  email: string;
  name: string;
  loginUrl: string;
}

export type PlatformLoginEmailQueue = Queue<PlatformLoginEmailPayload>;

export function createPlatformLoginEmailQueue(redisUrl: string): PlatformLoginEmailQueue {
  const url = new URL(redisUrl);
  return new Queue<PlatformLoginEmailPayload>(PLATFORM_LOGIN_EMAIL_QUEUE, {
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

export async function enqueuePlatformLoginEmail(
  queue: PlatformLoginEmailQueue,
  token: string,
  payload: PlatformLoginEmailPayload,
): Promise<void> {
  // jobId is deterministic on the token — prevents duplicate emails if the
  // endpoint is called twice before the first job runs.
  await queue.add('send', payload, { jobId: `platform-login.${token}` });
}
