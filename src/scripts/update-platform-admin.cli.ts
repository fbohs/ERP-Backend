import { parseArgs } from 'node:util';
import { createDb } from '../shared/db/index.js';
import { config } from '../shared/config/index.js';
import { logger } from '../shared/logging/index.js';
import { updatePlatformAdmin, type UpdatePlatformAdminInput } from './update-platform-admin.js';

// Entry point for:
//   npm run platform:update-admin -- --email <e> [--name <n>] [--active true|false]
// The `--` separator is required by npm to forward flags to the script (npm
// otherwise consumes them as its own config). Kept separate from
// update-platform-admin.ts so importing the core logic in tests does not trigger
// this top-level execution.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      active: { type: 'string' },
    },
  });

  const email = values.email?.trim();
  if (!email || !email.includes('@')) {
    logger.error('Usage: platform:update-admin -- --email <email> [--name <name>] [--active true|false]');
    process.exitCode = 1;
    return;
  }

  const hasName = values.name !== undefined;
  const hasActive = values.active !== undefined;
  if (!hasName && !hasActive) {
    logger.error('Nothing to update: provide --name and/or --active');
    process.exitCode = 1;
    return;
  }

  const name = hasName ? values.name!.trim() : undefined;
  if (hasName && name === '') {
    logger.error('--name cannot be empty');
    process.exitCode = 1;
    return;
  }

  let isActive: boolean | undefined;
  if (hasActive) {
    const raw = values.active!.trim().toLowerCase();
    if (raw !== 'true' && raw !== 'false') {
      logger.error('--active must be "true" or "false"');
      process.exitCode = 1;
      return;
    }
    isActive = raw === 'true';
  }

  if (config.databaseUrl === '') {
    logger.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  // Build the input with only the fields actually supplied — exactOptionalProperty
  // Types forbids passing an explicit `undefined` for an optional property.
  const input: UpdatePlatformAdminInput = { email };
  if (name !== undefined) input.name = name;
  if (isActive !== undefined) input.isActive = isActive;

  const db = createDb(config.databaseUrl);
  try {
    const result = await updatePlatformAdmin(db, input);
    if (result.status === 'not_found') {
      logger.error({ email }, 'No platform admin with that email');
      process.exitCode = 1;
      return;
    }
    logger.info({ email: result.email, publicId: result.publicId, name, isActive }, 'Platform admin updated');
  } catch (err) {
    logger.error({ err }, 'Failed to update platform admin');
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

await main();
