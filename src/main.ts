import { buildApp } from './app.js';
import { config } from './shared/config/index.js';
import { logger } from './shared/logging/index.js';
import { assertInfraReady } from './shared/infra/probe.js';

await assertInfraReady();

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
}
