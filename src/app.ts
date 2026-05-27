import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { logger } from './shared/logging/index.js';
import { registerErrorHandler } from './shared/errors/handler.js';
import { healthPlugin } from './modules/health/index.js';
import { authPlugin } from './modules/auth/index.js';
import { platformPlugin } from './modules/platform/index.js';
import { createDb } from './shared/db/index.js';
import { createRedis } from './shared/cache/redis.js';
import { startEmailWorkers } from './workers/email.worker.js';
import { bullBoardPlugin } from './shared/queue/bull-board.js';
import { config } from './shared/config/index.js';
import { createIpAllowlist } from './shared/auth/index.js';
import { NotFoundError } from './shared/errors/base.js';

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

  const ipAllowlistStr = overrides?.platformIpAllowlist ?? config.platformIpAllowlist;
  const platformAllowlist = createIpAllowlist(ipAllowlistStr);

  // Cast needed: Fastify infers a wider Logger type from loggerInstance
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.trustProxy,
  }) as unknown as FastifyInstance;

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'ERP Platform API',
        description: 'Internal API for platform administration. All routes require IP allowlisting.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Session token obtained from POST /platform/auth/verify',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/platform/docs',
    uiHooks: {
      onRequest: async (request) => {
        if (!platformAllowlist.allows(request.ip)) {
          throw new NotFoundError('Not found');
        }
      },
    },
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  // Email is a single feature: the queues and their workers are created together
  // or not at all. With it off, emails are simply not sent — never enqueued to
  // pile up unconsumed.
  const emailEnabled = config.resendApiKey !== '';
  const emailWorkers = emailEnabled
    ? startEmailWorkers(queueRedisUrl, config.resendApiKey, {
        emailFrom: config.emailFrom,
        passwordResetTtlMinutes: config.passwordResetTtlSeconds / 60,
        platformLoginTtlMinutes: config.platformLoginTokenTtlSeconds / 60,
        appBaseUrl: config.appBaseUrl,
      })
    : [];
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
    queueRedis,
    emailQueueUrl: emailEnabled ? queueRedisUrl : null,
    appBaseUrl: config.appBaseUrl,
    ipAllowlist: overrides?.platformIpAllowlist ?? config.platformIpAllowlist,
  });

  if (queueRedisUrl !== '') {
    await app.register(bullBoardPlugin, {
      queueRedisUrl,
      ipAllowlist: overrides?.platformIpAllowlist ?? config.platformIpAllowlist,
    });
  }

  return app;
}
