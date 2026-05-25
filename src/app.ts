import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './shared/logging/index.js';
import { registerErrorHandler } from './shared/errors/handler.js';
import { healthPlugin } from './modules/health/index.js';
import { authPlugin } from './modules/auth/index.js';
import { platformPlugin } from './modules/platform/index.js';
import { createDb } from './shared/db/index.js';
import { createRedis } from './shared/cache/redis.js';
import { startEmailWorkers } from './workers/email.worker.js';
import { config } from './shared/config/index.js';

export interface AppOverrides {
  databaseUrl?: string;
  redisUrl?: string;
  queueRedisUrl?: string;
  // Comma-separated IPv4/IPv6 addresses and IPv4 CIDR ranges allowed to reach
  // the /platform/* surface. Consumed once the platform plugin is wired in.
  platformIpAllowlist?: string;
}

export async function buildApp(overrides?: AppOverrides): Promise<FastifyInstance> {
  const db = createDb(overrides?.databaseUrl ?? config.databaseUrl);
  const redis = createRedis(overrides?.redisUrl ?? config.redisUrl);
  const queueRedisUrl = overrides?.queueRedisUrl ?? config.queueRedisUrl;
  // Idempotency keys must survive a restart, so they live on the durable
  // (AOF-persisted) queue Redis, not the evictable session cache.
  const queueRedis = createRedis(queueRedisUrl);

  // Cast needed: Fastify infers a wider Logger type from loggerInstance
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.trustProxy,
  }) as unknown as FastifyInstance;

  // Email is a single feature: the queues and their workers are created together
  // or not at all. With it off, emails are simply not sent — never enqueued to
  // pile up unconsumed.
  const emailEnabled = config.resendApiKey !== '';
  const emailWorkers = emailEnabled ? startEmailWorkers(queueRedisUrl, config.resendApiKey) : [];
  if (!emailEnabled) {
    logger.warn('RESEND_API_KEY not set — password reset and platform login emails are disabled');
  }

  app.addHook('onClose', async () => {
    await Promise.all(emailWorkers.map((worker) => worker.close()));
    await db.destroy();
    await redis.quit();
    await queueRedis.quit();
  });

  registerErrorHandler(app);

  await app.register(healthPlugin);
  await app.register(authPlugin, {
    db,
    redis,
    queueRedis,
    emailQueueUrl: emailEnabled ? queueRedisUrl : null,
    appBaseUrl: config.appBaseUrl,
  });
  await app.register(platformPlugin, {
    db,
    redis,
    queueRedis,
    emailQueueUrl: emailEnabled ? queueRedisUrl : null,
    appBaseUrl: config.appBaseUrl,
    ipAllowlist: overrides?.platformIpAllowlist ?? config.platformIpAllowlist,
  });

  return app;
}
