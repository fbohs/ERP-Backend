import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type AppDb } from '@/shared/db/index.js';
import { revokePlatformAdminSessions } from '@/scripts/revoke-platform-admin-sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../prisma/migrations');

function loadMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

describe('revokePlatformAdminSessions', () => {
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

  async function seedAdminWithSessions(email: string, sessionCount: number): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "PlatformAdmin" (email, name) VALUES ($1, 'Ops') RETURNING id`,
      [email],
    );
    const adminId = res.rows[0]!.id;
    for (let i = 0; i < sessionCount; i++) {
      await pool.query(
        `INSERT INTO "PlatformAdminSession" ("tokenHash", "adminId", "expiresAt") VALUES ($1, $2, $3)`,
        [randomBytes(32).toString('hex'), adminId, new Date(Date.now() + 60 * 60 * 1_000)],
      );
    }
    return adminId;
  }

  it('deletes all sessions for the admin and records the count in an audit row', async () => {
    const email = 'leaked@platform.test';
    const adminId = await seedAdminWithSessions(email, 2);

    const result = await revokePlatformAdminSessions(db, { email });
    expect(result.status).toBe('revoked');
    expect(result.revokedCount).toBe(2);

    const sessions = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "PlatformAdminSession" WHERE "adminId" = $1`,
      [adminId],
    );
    expect(sessions.rows[0]!.n).toBe(0);

    const audit = await pool.query<{ after: { revokedCount: number } }>(
      `SELECT after FROM "PlatformAuditLog"
       WHERE action = 'platform.sessions_revoked' AND "adminId" = $1 ORDER BY id DESC LIMIT 1`,
      [adminId],
    );
    expect(audit.rows[0]!.after.revokedCount).toBe(2);
  });

  it('returns revoked with count 0 when the admin has no live sessions', async () => {
    const email = 'nosessions@platform.test';
    await seedAdminWithSessions(email, 0);

    const result = await revokePlatformAdminSessions(db, { email });
    expect(result.status).toBe('revoked');
    expect(result.revokedCount).toBe(0);
  });

  it('returns not_found for an unknown email', async () => {
    const result = await revokePlatformAdminSessions(db, { email: 'ghost@platform.test' });
    expect(result.status).toBe('not_found');
    expect(result.revokedCount).toBe(0);
  });
});
