import Fastify from 'fastify';
import { logger } from './shared/logging/index.js';
import { registerErrorHandler } from './shared/errors/handler.js';
import { healthPlugin } from './modules/health/index.js';

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  registerErrorHandler(app);

  await app.register(healthPlugin);

  return app;
}
