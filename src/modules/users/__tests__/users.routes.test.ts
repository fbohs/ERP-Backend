import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import { hash as argon2Hash } from 'argon2';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../../prisma/migrations');

function loadMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

const MERCHANT_SPECS = {
  merchant: {
    businessName: 'Gadget World',
    registrationNumber: 'REG-001',
    address: '1 Market St',
    phoneNumber: '+1234567890',
  },
};

const VERIFIER_SPECS = {
  verifier: {
    badgeId: 'BADGE-42',
    certificationLevel: 'SENIOR',
    specializations: ['electronics', 'apparel'],
    certifiedUntil: '2027-12-31',
  },
};

describe('users routes', () => {
  let app: FastifyInstance;
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let adminToken: string;
  let adminPublicId: string;

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

    const passwordHash = await argon2Hash('admin-password');
    const adminResult = await pool.query<{ id: string; "publicId": string }>(
      `INSERT INTO "User" ("tenantId", email, name, password, role)
       VALUES ($1, 'admin@acme.com', 'Admin User', $2, 'ADMIN')
       RETURNING id, "publicId"`,
      [tenantId, passwordHash],
    );
    adminPublicId = adminResult.rows[0]!.publicId;

    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getFirstMappedPort()}`;
    app = await buildApp({
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl,
      queueRedisUrl: redisUrl,
    });
    await app.ready();

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@acme.com', password: 'admin-password' },
    });
    adminToken = loginRes.json<{ token: string }>().token;
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([pgContainer.stop(), redisContainer.stop()]);
  });

  // ---------------------------------------------------------------------------
  // POST /users
  // ---------------------------------------------------------------------------

  describe('POST /users', () => {
    it('creates a MERCHANT user and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'merchant@acme.com',
          name: 'Merchant One',
          role: 'MERCHANT',
          specs: MERCHANT_SPECS,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; email: string; role: string }>();
      expect(typeof body.id).toBe('string');
      expect(body.email).toBe('merchant@acme.com');
      expect(body.role).toBe('MERCHANT');

      const row = await pool.query<{ role: string; specs: unknown; mustChangePassword: boolean }>(
        `SELECT role, specs, "mustChangePassword" FROM "User" WHERE email = 'merchant@acme.com'`,
      );
      expect(row.rows[0]!.role).toBe('MERCHANT');
      expect(row.rows[0]!.mustChangePassword).toBe(true);
      expect(row.rows[0]!.specs).toMatchObject(MERCHANT_SPECS);

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'user.created' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('user.created');
    });

    it('creates a PRODUCT_VERIFIER user and stores verifier specs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'verifier@acme.com',
          name: 'Verifier One',
          role: 'PRODUCT_VERIFIER',
          specs: VERIFIER_SPECS,
        },
      });

      expect(res.statusCode).toBe(201);
      const row = await pool.query<{ specs: unknown }>(
        `SELECT specs FROM "User" WHERE email = 'verifier@acme.com'`,
      );
      expect(row.rows[0]!.specs).toMatchObject(VERIFIER_SPECS);
    });

    it('creates a REPORT_VIEWER user with null specs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'viewer@acme.com',
          name: 'Viewer One',
          role: 'REPORT_VIEWER',
          specs: null,
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 409 when email is already in use', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'merchant@acme.com',
          name: 'Duplicate',
          role: 'MERCHANT',
          specs: MERCHANT_SPECS,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('EMAIL_ALREADY_TAKEN');
    });

    it('returns 422 when MERCHANT specs are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'bad-merchant@acme.com',
          name: 'Bad Merchant',
          role: 'MERCHANT',
          specs: null,
        },
      });

      expect(res.statusCode).toBe(422);
    });

    it('returns 422 when required fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'x@x.com', role: 'REPORT_VIEWER' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('returns 401 without a session token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: {
          email: 'anon@acme.com',
          name: 'Anon',
          role: 'REPORT_VIEWER',
          specs: null,
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /users
  // ---------------------------------------------------------------------------

  describe('GET /users', () => {
    it('returns all users in the tenant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ users: { email: string }[] }>();
      expect(Array.isArray(body.users)).toBe(true);
      // At minimum: admin + merchant + verifier + viewer created above
      expect(body.users.length).toBeGreaterThanOrEqual(4);
    });

    it('returns 401 without a session token', async () => {
      const res = await app.inject({ method: 'GET', url: '/users' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /users/:id
  // ---------------------------------------------------------------------------

  describe('GET /users/:id', () => {
    it('returns the user with specs', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const { users } = listRes.json<{ users: { id: string; email: string }[] }>();
      const merchant = users.find((u) => u.email === 'merchant@acme.com')!;

      const res = await app.inject({
        method: 'GET',
        url: `/users/${merchant.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; role: string; specs: unknown }>();
      expect(body.role).toBe('MERCHANT');
      expect(body.specs).toMatchObject(MERCHANT_SPECS);
    });

    it('returns 404 for an unknown user id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/users/${randomUUID()}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 422 for a non-UUID id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/not-a-uuid',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /users/:id — suspend / reactivate
  // ---------------------------------------------------------------------------

  describe('PATCH /users/:id', () => {
    let merchantId: string;

    beforeAll(async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const { users } = listRes.json<{ users: { id: string; email: string }[] }>();
      merchantId = users.find((u) => u.email === 'merchant@acme.com')!.id;
    });

    it('suspends a user and returns isActive: false', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${merchantId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ isActive: boolean }>().isActive).toBe(false);

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'user.suspended' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('user.suspended');
    });

    it('reactivates a suspended user', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${merchantId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { isActive: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ isActive: boolean }>().isActive).toBe(true);
    });

    it('returns 403 when trying to suspend self', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${adminPublicId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CANNOT_MODIFY_SELF');
    });

    it('returns 404 for an unknown user id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${randomUUID()}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /users/:id
  // ---------------------------------------------------------------------------

  describe('DELETE /users/:id', () => {
    let viewerId: string;

    beforeAll(async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const { users } = listRes.json<{ users: { id: string; email: string }[] }>();
      viewerId = users.find((u) => u.email === 'viewer@acme.com')!.id;
    });

    it('soft-deletes a user and returns 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${viewerId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(204);

      const row = await pool.query<{ isActive: boolean }>(
        `SELECT "isActive" FROM "User" WHERE email = 'viewer@acme.com'`,
      );
      expect(row.rows[0]!.isActive).toBe(false);

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'user.deleted' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('user.deleted');
    });

    it('returns 403 when trying to delete self', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${adminPublicId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CANNOT_MODIFY_SELF');
    });

    it('returns 404 for an unknown user id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${randomUUID()}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency-Key
  // ---------------------------------------------------------------------------

  describe('Idempotency-Key on POST /users', () => {
    it('replays the stored response without creating a second user', async () => {
      const idemKey = randomBytes(16).toString('hex');
      const payload = {
        email: `idem-${idemKey}@acme.com`,
        name: 'Idem User',
        role: 'REPORT_VIEWER',
        specs: null,
      };

      const first = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': idemKey },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': idemKey },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);

      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "User" WHERE email = $1`,
        [payload.email],
      );
      expect(count.rows[0]!.n).toBe(1);
    });
  });
});
