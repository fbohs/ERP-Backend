import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../../prisma/migrations/20260514142014_init/migration.sql'),
  'utf-8',
);

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
    await pool.query(MIGRATION_SQL);

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
       VALUES ($1, 'inactive@acme.com', 'Inactive User', $2, 'VIEWER', false)`,
      [tenantId, inactiveHash],
    );

    app = await buildApp({
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl: `redis://${redisContainer.getHost()}:${redisContainer.getFirstMappedPort()}`,
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
    });

    it('returns 401 on wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@acme.com', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
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

    it('returns 400 on missing fields', async () => {
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
});
