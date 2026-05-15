import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './shared/logging/index.js';
import { registerErrorHandler } from './shared/errors/handler.js';
import { healthPlugin } from './modules/health/index.js';
import { authPlugin } from './modules/auth/index.js';
import { createDb } from './shared/db/index.js';
import { createRedis } from './shared/cache/redis.js';
import { startEmailWorker } from './workers/email.worker.js';
import { config } from './shared/config/index.js';

export interface AppOverrides {
  databaseUrl?: string;
  redisUrl?: string;
  queueRedisUrl?: string;
}

export async function buildApp(overrides?: AppOverrides): Promise<FastifyInstance> {
  const db = createDb(overrides?.databaseUrl ?? config.databaseUrl);
  const redis = createRedis(overrides?.redisUrl ?? config.redisUrl);
  const queueRedisUrl = overrides?.queueRedisUrl ?? config.queueRedisUrl;
  // Idempotency keys must survive a restart, so they live on the durable
  // (AOF-persisted) queue Redis, not the evictable session cache.
  const queueRedis = createRedis(queueRedisUrl);

  // Cast needed: Fastify infers a wider Logger type from loggerInstance
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;

  // Email is a single feature: the queue and its worker are created together
  // or not at all. With it off, password-reset emails are simply not sent —
  // never enqueued to pile up unconsumed.
  const emailEnabled = config.resendApiKey !== '';
  const emailWorker = emailEnabled
    ? startEmailWorker(queueRedisUrl, config.resendApiKey)
    : null;
  if (!emailEnabled) {
    logger.warn('RESEND_API_KEY not set — password reset emails are disabled');
  }

  app.addHook('onClose', async () => {
    await emailWorker?.close();
    await db.destroy();
    redis.disconnect();
    queueRedis.disconnect();
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

  return app;
}
