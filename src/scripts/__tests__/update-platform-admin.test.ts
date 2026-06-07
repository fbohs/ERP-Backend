import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type AppDb } from '@/shared/db/index.js';
import { updatePlatformAdmin } from '@/scripts/update-platform-admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../prisma/migrations');

function loadMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

describe('updatePlatformAdmin', () => {
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

  async function seedAdmin(email: string, name = 'Original'): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "PlatformAdmin" (email, name) VALUES ($1, $2) RETURNING id`,
      [email, name],
    );
    return res.rows[0]!.id;
  }

  it('updates the name and records an audit row with before/after', async () => {
    const email = 'rename@platform.test';
    const adminId = await seedAdmin(email, 'Old Name');

    const result = await updatePlatformAdmin(db, { email, name: 'New Name' });
    expect(result.status).toBe('updated');

    const row = await pool.query<{ name: string; isActive: boolean }>(
      `SELECT name, "isActive" FROM "PlatformAdmin" WHERE email = $1`,
      [email],
    );
    expect(row.rows[0]!.name).toBe('New Name');
    expect(row.rows[0]!.isActive).toBe(true); // unchanged

    const audit = await pool.query<{ before: { name: string }; after: { name: string } }>(
      `SELECT before, after FROM "PlatformAuditLog"
       WHERE action = 'platform.admin_updated' AND "adminId" = $1 ORDER BY id DESC LIMIT 1`,
      [adminId],
    );
    expect(audit.rows[0]!.before.name).toBe('Old Name');
    expect(audit.rows[0]!.after.name).toBe('New Name');
  });

  it('deactivates the admin (isActive=false) without touching the name', async () => {
    const email = 'deactivate@platform.test';
    await seedAdmin(email, 'Keep Name');

    const result = await updatePlatformAdmin(db, { email, isActive: false });
    expect(result.status).toBe('updated');

    const row = await pool.query<{ name: string; isActive: boolean }>(
      `SELECT name, "isActive" FROM "PlatformAdmin" WHERE email = $1`,
      [email],
    );
    expect(row.rows[0]!.isActive).toBe(false);
    expect(row.rows[0]!.name).toBe('Keep Name');
  });

  it('updates name and isActive together', async () => {
    const email = 'both@platform.test';
    await seedAdmin(email, 'Before');

    const result = await updatePlatformAdmin(db, { email, name: 'After', isActive: false });
    expect(result.status).toBe('updated');

    const row = await pool.query<{ name: string; isActive: boolean }>(
      `SELECT name, "isActive" FROM "PlatformAdmin" WHERE email = $1`,
      [email],
    );
    expect(row.rows[0]!.name).toBe('After');
    expect(row.rows[0]!.isActive).toBe(false);
  });

  it('returns not_found for an unknown email and writes no audit row', async () => {
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "PlatformAuditLog" WHERE action = 'platform.admin_updated'`,
    );
    const result = await updatePlatformAdmin(db, { email: 'ghost@platform.test', name: 'X' });
    expect(result.status).toBe('not_found');

    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "PlatformAuditLog" WHERE action = 'platform.admin_updated'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
