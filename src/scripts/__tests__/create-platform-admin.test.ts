import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type AppDb } from '@/shared/db/index.js';
import { createPlatformAdmin } from '@/scripts/create-platform-admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../prisma/migrations');

function loadMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

describe('createPlatformAdmin', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: AppDb;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:18-alpine').start();
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    for (const sql of loadMigrations()) {
      await pool.query(sql);
    }
    db = createDb(pgContainer.getConnectionUri());
  }, 90_000);

  afterAll(async () => {
    await db.destroy();
    await pool.end();
    await pgContainer.stop();
  });

  it('creates a new platform admin', async () => {
    const result = await createPlatformAdmin(db, {
      email: 'founder@platform.test',
      name: 'Founder',
    });

    expect(result.status).toBe('created');
    expect(result.publicId.length).toBeGreaterThan(0);

    const rows = await pool.query<{ name: string }>(
      `SELECT name FROM "PlatformAdmin" WHERE email = 'founder@platform.test'`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.name).toBe('Founder');

    const audit = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "PlatformAuditLog" WHERE action = 'platform.admin_created'`,
    );
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('is idempotent on email — a second call creates no duplicate', async () => {
    const result = await createPlatformAdmin(db, {
      email: 'founder@platform.test',
      name: 'Someone Else',
    });

    expect(result.status).toBe('exists');

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "PlatformAdmin" WHERE email = 'founder@platform.test'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
});
