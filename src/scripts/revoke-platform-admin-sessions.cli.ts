import { parseArgs } from 'node:util';
import { createDb } from '@/shared/db/index.js';
import { config } from '@/shared/config/index.js';
import { logger } from '@/shared/logging/index.js';
import { revokePlatformAdminSessions } from './revoke-platform-admin-sessions.js';

// Entry point for:
//   npm run platform:revoke-sessions -- --email <e>
// The `--` separator is required by npm to forward the flag to the script. Kept
// separate from revoke-platform-admin-sessions.ts so importing the core logic in
// tests does not trigger this top-level execution.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
    },
  });

  const email = values.email?.trim();
  if (!email || !email.includes('@')) {
    logger.error('Usage: platform:revoke-sessions -- --email <email>');
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
    const result = await revokePlatformAdminSessions(db, { email });
    if (result.status === 'not_found') {
      logger.error({ email }, 'No platform admin with that email');
      process.exitCode = 1;
      return;
    }
    logger.info({ email: result.email, revokedCount: result.revokedCount }, 'Platform admin sessions revoked');
  } catch (err) {
    logger.error({ err }, 'Failed to revoke platform admin sessions');
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

await main();
