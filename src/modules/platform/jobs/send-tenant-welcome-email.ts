import { Queue } from 'bullmq';

export const TENANT_WELCOME_EMAIL_QUEUE = 'platform.tenant-welcome-email';

export interface TenantWelcomeEmailPayload {
  email: string;
  name: string;
  tenantName: string;
  temporaryPassword: string;
  loginUrl: string;
}

export type TenantWelcomeEmailQueue = Queue<TenantWelcomeEmailPayload>;

export function createTenantWelcomeEmailQueue(redisUrl: string): TenantWelcomeEmailQueue {
  const url = new URL(redisUrl);
  return new Queue<TenantWelcomeEmailPayload>(TENANT_WELCOME_EMAIL_QUEUE, {
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

export async function enqueueTenantWelcomeEmail(
  queue: TenantWelcomeEmailQueue,
  tenantId: string,
  payload: TenantWelcomeEmailPayload,
): Promise<void> {
  // jobId is deterministic on the tenant — prevents duplicate welcome emails
  // if createTenant is retried before the first job runs.
  await queue.add('send', payload, { jobId: `tenant-welcome.${tenantId}` });
}
