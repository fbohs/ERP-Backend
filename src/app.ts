import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './shared/logging/index.js';
import { registerErrorHandler } from './shared/errors/handler.js';
import { healthPlugin } from './modules/health/index.js';
import { authPlugin } from './modules/auth/index.js';
import { createDb } from './shared/db/index.js';
import { createRedis } from './shared/cache/redis.js';
import { config } from './shared/config/index.js';

export interface AppOverrides {
  databaseUrl?: string;
  redisUrl?: string;
}

export async function buildApp(overrides?: AppOverrides): Promise<FastifyInstance> {
  const db = createDb(overrides?.databaseUrl ?? config.databaseUrl);
  const redis = createRedis(overrides?.redisUrl ?? config.redisUrl);

  // Cast needed: Fastify infers a wider Logger type from loggerInstance
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;

  app.addHook('onClose', async () => {
    await db.destroy();
    redis.disconnect();
  });

  registerErrorHandler(app);

  await app.register(healthPlugin);
  await app.register(authPlugin, { db, redis });

  return app;
}
