import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';

function sha256(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../prisma/migrations');

function loadMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((entry) => fs.statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

describe('auth routes', () => {
  let app: FastifyInstance;
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let sessionToken: string;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:18-alpine').start(),
      new RedisContainer('redis:8.6-alpine').start(),
    ]);

    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    for (const sql of loadMigrations()) {
      await pool.query(sql);
    }

    const tenantResult = await pool.query<{ id: string }>(
      `INSERT INTO "Tenant" (name, slug) VALUES ('Acme Corp', 'acme') RETURNING id`,
    );
    const tenantId = tenantResult.rows[0]!.id;

    const passwordHash = await argon2.hash('correct-password');
    await pool.query(
      `INSERT INTO "User" ("tenantId", email, name, password, role)
       VALUES ($1, 'admin@acme.com', 'Admin User', $2, 'ADMIN')`,
      [tenantId, passwordHash],
    );

    const inactiveHash = await argon2.hash('any-password');
    await pool.query(
      `INSERT INTO "User" ("tenantId", email, name, password, role, "isActive")
       VALUES ($1, 'inactive@acme.com', 'Inactive User', $2, 'REPORT_VIEWER', false)`,
      [tenantId, inactiveHash],
    );

    const resetHash = await argon2.hash('reset-original-password');
    await pool.query(
      `INSERT INTO "User" ("tenantId", email, name, password, role)
       VALUES ($1, 'reset@acme.com', 'Reset User', $2, 'REPORT_VIEWER')`,
      [tenantId, resetHash],
    );

    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getFirstMappedPort()}`;
    app = await buildApp({
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl,
      queueRedisUrl: redisUrl,
    });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([pgContainer.stop(), redisContainer.stop()]);
  });

  describe('POST /auth/login', () => {
    it('returns 200 with token, user and tenant on valid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@acme.com', password: 'correct-password' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ token: string; user: { role: string; name: string }; tenant: { slug: string } }>();
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);
      expect(body.user.role).toBe('ADMIN');
      expect(body.user.name).toBe('Admin User');
      expect(body.tenant.slug).toBe('acme');

      sessionToken = body.token;

      const audit = await pool.query<{
        entityType: string;
        tenantId: string;
        actorId: string;
        requestId: string | null;
      }>(
        `SELECT al."entityType", al."tenantId", al."actorId", al."requestId"
         FROM "AuditLog" al
         JOIN "User" u ON u.id = al."actorId"
         WHERE u.email = 'admin@acme.com' AND al.action = 'auth.login'
         ORDER BY al.id DESC LIMIT 1`,
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.entityType).toBe('User');
      expect(audit.rows[0]!.tenantId).not.toBeNull();
      expect(audit.rows[0]!.actorId).not.toBeNull();
      expect(audit.rows[0]!.requestId).not.toBeNull();
    });

    it('returns 401 on wrong password', async () => {
      const before = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'auth.login'`,
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@acme.com', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);

      // a rejected login must not leave an audit row behind
      const after = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'auth.login'`,
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('returns 401 on unknown email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@acme.com', password: 'any-password' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when user is inactive', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'inactive@acme.com', password: 'any-password' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 422 on missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@acme.com' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('DELETE /auth/logout', () => {
    it('returns 401 with no token', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/auth/logout' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 204 and invalidates the session', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(res.statusCode).toBe(204);

      const audit = await pool.query<{ entityType: string; requestId: string | null }>(
        `SELECT al."entityType", al."requestId"
         FROM "AuditLog" al
         JOIN "User" u ON u.id = al."actorId"
         WHERE u.email = 'admin@acme.com' AND al.action = 'auth.logout'
         ORDER BY al.id DESC LIMIT 1`,
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.entityType).toBe('User');
      expect(audit.rows[0]!.requestId).not.toBeNull();
    });

    it('returns 401 after logout with the same token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('returns 200 when email exists and creates a reset token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'admin@acme.com' },
      });
      expect(res.statusCode).toBe(200);

      const result = await pool.query<{ token: string }>(
        `SELECT prt.token FROM "PasswordResetToken" prt
         JOIN "User" u ON u.id = prt."userId"
         WHERE u.email = 'admin@acme.com'
         ORDER BY prt."createdAt" DESC LIMIT 1`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.token.length).toBeGreaterThan(0);

      const audit = await pool.query<{ entityType: string; requestId: string | null }>(
        `SELECT al."entityType", al."requestId"
         FROM "AuditLog" al
         JOIN "User" u ON u.id = al."actorId"
         WHERE u.email = 'admin@acme.com' AND al.action = 'auth.password_reset_requested'
         ORDER BY al.id DESC LIMIT 1`,
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.entityType).toBe('User');
      expect(audit.rows[0]!.requestId).not.toBeNull();
    });

    it('returns 200 when email does not exist (no enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'nobody@acme.com' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 422 on invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('invalidates prior unused reset tokens when a new one is issued', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'admin@acme.com' },
      });
      await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'admin@acme.com' },
      });

      const unused = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PasswordResetToken" prt
         JOIN "User" u ON u.id = prt."userId"
         WHERE u.email = 'admin@acme.com' AND prt."usedAt" IS NULL`,
      );
      // only the most recently issued token remains live
      expect(unused.rows[0]!.n).toBe(1);
    });
  });

  describe('POST /auth/reset-password', () => {
    let validToken: string;
    let expiredToken: string;
    let usedToken: string;
    let preResetSessionToken: string;

    beforeAll(async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'reset@acme.com', password: 'reset-original-password' },
      });
      preResetSessionToken = loginRes.json<{ token: string }>().token;

      const userResult = await pool.query<{ id: string }>(
        `SELECT id FROM "User" WHERE email = 'reset@acme.com'`,
      );
      const userId = userResult.rows[0]!.id;

      validToken = crypto.randomBytes(32).toString('hex');
      expiredToken = crypto.randomBytes(32).toString('hex');
      usedToken = crypto.randomBytes(32).toString('hex');

      await pool.query(
        `INSERT INTO "PasswordResetToken" (token, "userId", "expiresAt") VALUES ($1, $2, $3)`,
        [sha256(validToken), userId, new Date(Date.now() + 30 * 60 * 1_000)],
      );
      await pool.query(
        `INSERT INTO "PasswordResetToken" (token, "userId", "expiresAt") VALUES ($1, $2, $3)`,
        [sha256(expiredToken), userId, new Date(Date.now() - 1_000)],
      );
      await pool.query(
        `INSERT INTO "PasswordResetToken" (token, "userId", "expiresAt", "usedAt") VALUES ($1, $2, $3, $4)`,
        [sha256(usedToken), userId, new Date(Date.now() + 30 * 60 * 1_000), new Date()],
      );
    });

    it('returns 200, updates password, and invalidates all sessions on valid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: validToken, newPassword: 'reset-new-password-456' },
      });
      expect(res.statusCode).toBe(200);

      const audit = await pool.query<{ entityType: string; requestId: string | null }>(
        `SELECT al."entityType", al."requestId"
         FROM "AuditLog" al
         JOIN "User" u ON u.id = al."actorId"
         WHERE u.email = 'reset@acme.com' AND al.action = 'auth.password_reset_completed'
         ORDER BY al.id DESC LIMIT 1`,
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.entityType).toBe('User');
      expect(audit.rows[0]!.requestId).not.toBeNull();

      // pre-reset session must now be rejected
      const oldSessionRes = await app.inject({
        method: 'DELETE',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${preResetSessionToken}` },
      });
      expect(oldSessionRes.statusCode).toBe(401);

      // new password must work
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'reset@acme.com', password: 'reset-new-password-456' },
      });
      expect(loginRes.statusCode).toBe(200);
    });

    it('returns 401 on expired token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: expiredToken, newPassword: 'any-password' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 on already-used token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: usedToken, newPassword: 'any-password' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 on unknown token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: 'a'.repeat(64), newPassword: 'any-password' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 422 on missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: validToken },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('Idempotency-Key', () => {
    const adminTokenCount = `SELECT count(*)::int AS n FROM "PasswordResetToken" prt
       JOIN "User" u ON u.id = prt."userId" WHERE u.email = 'admin@acme.com'`;

    it('replays the stored response without re-running the handler', async () => {
      const idemKey = crypto.randomBytes(16).toString('hex');

      const first = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        headers: { 'idempotency-key': idemKey },
        payload: { email: 'admin@acme.com' },
      });
      const afterFirst = await pool.query<{ n: number }>(adminTokenCount);

      const second = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        headers: { 'idempotency-key': idemKey },
        payload: { email: 'admin@acme.com' },
      });
      const afterSecond = await pool.query<{ n: number }>(adminTokenCount);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // the replayed call must not touch the database at all
      expect(afterSecond.rows[0]!.n).toBe(afterFirst.rows[0]!.n);
    });

    it('replays the same login response without creating a second session', async () => {
      const idemKey = crypto.randomBytes(16).toString('hex');
      const payload = { email: 'admin@acme.com', password: 'correct-password' };

      const first = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'idempotency-key': idemKey },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'idempotency-key': idemKey },
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstToken = first.json<{ token: string }>().token;
      expect(second.json<{ token: string }>().token).toBe(firstToken);

      const sessions = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Session" WHERE token = $1`,
        [sha256(firstToken)],
      );
      expect(sessions.rows[0]!.n).toBe(1);
    });

    it('rejects a key reused with a different request body with 409', async () => {
      const idemKey = crypto.randomBytes(16).toString('hex');

      const first = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        headers: { 'idempotency-key': idemKey },
        payload: { email: 'admin@acme.com' },
      });
      const conflicting = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        headers: { 'idempotency-key': idemKey },
        payload: { email: 'reset@acme.com' },
      });

      expect(first.statusCode).toBe(200);
      expect(conflicting.statusCode).toBe(409);
    });
  });
});
