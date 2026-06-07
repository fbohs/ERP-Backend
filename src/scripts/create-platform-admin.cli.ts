import { parseArgs } from 'node:util';
import { createDb } from '@/shared/db/index.js';
import { config } from '@/shared/config/index.js';
import { logger } from '@/shared/logging/index.js';
import { createPlatformAdmin } from './create-platform-admin.js';

// Entry point for `npm run platform:create-admin -- --email <e> --name <n>`.
// Kept separate from create-platform-admin.ts so importing the core logic in
// tests does not trigger this top-level execution.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
    },
  });

  const email = values.email?.trim();
  const name = values.name?.trim();

  if (!email || !name || !email.includes('@')) {
    logger.error('Usage: platform:create-admin -- --email <email> --name <name>');
    process.exitCode = 1;
    return;
  }

  if (config.databaseUrl === '') {
    logger.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const db = createDb(config.databaseUrl);
  try {
    const result = await createPlatformAdmin(db, { email, name });
    const message =
      result.status === 'created'
        ? 'Platform admin created'
        : 'Platform admin already exists — no change';
    logger.info({ email: result.email, publicId: result.publicId }, message);
  } catch (err) {
    logger.error({ err }, 'Failed to create platform admin');
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

await main();
