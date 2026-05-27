import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../prisma/migrations');

// The allowlist used for the whole suite: loopback (what inject sends by
// default) plus the private 10.0.0.0/8 block, to exercise multi-entry CIDR.
const ALLOWLIST = '127.0.0.0/8,10.0.0.0/8';
const BLOCKED_IP = '203.0.113.5'; // TEST-NET-3, outside the allowlist

function loadMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((entry) => fs.statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

const ADMIN_EMAIL = 'ops@platform.test';

// Mirrors shared/auth/token-hash.ts — tokens are stored as their SHA-256 hash,
// so tests insert the hash and submit the raw token.
function sha256hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('platform routes', () => {
  let app: FastifyInstance;
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let adminId: string;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:18-alpine').start(),
      new RedisContainer('redis:8.6-alpine').start(),
    ]);

    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    for (const sql of loadMigrations()) {
      await pool.query(sql);
    }

    const adminResult = await pool.query<{ id: string }>(
      `INSERT INTO "PlatformAdmin" (email, name) VALUES ($1, 'Ops Admin') RETURNING id`,
      [ADMIN_EMAIL],
    );
    adminId = adminResult.rows[0]!.id;

    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getFirstMappedPort()}`;
    app = await buildApp({
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl,
      queueRedisUrl: redisUrl,
      platformIpAllowlist: ALLOWLIST,
    });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([pgContainer.stop(), redisContainer.stop()]);
  });

  // Issues a fresh login token row (hash stored, raw submitted) and exchanges it
  // for a live session token.
  async function freshSessionToken(): Promise<string> {
    const raw = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO "PlatformAdminLoginToken" ("tokenHash", "adminId", "expiresAt") VALUES ($1, $2, $3)`,
      [sha256hex(raw), adminId, new Date(Date.now() + 30 * 60 * 1_000)],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/platform/auth/verify',
      payload: { token: raw },
    });
    return res.json<{ token: string }>().token;
  }

  describe('IP allowlist', () => {
    it('returns 404 (surface hidden) for a non-allowlisted IP', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        remoteAddress: BLOCKED_IP,
        payload: { email: ADMIN_EMAIL },
      });
      expect(res.statusCode).toBe(404);
    });

    it('reaches the handler (not 404) for a loopback IP in 127.0.0.0/8', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        remoteAddress: '127.0.0.1',
        payload: { email: ADMIN_EMAIL },
      });
      expect(res.statusCode).not.toBe(404);
    });

    it('reaches the handler for an IP inside the second CIDR entry (10.0.0.0/8)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        remoteAddress: '10.4.5.6',
        payload: { email: ADMIN_EMAIL },
      });
      expect(res.statusCode).not.toBe(404);
    });
  });

  describe('POST /platform/auth/request-link', () => {
    it('returns 200 and creates a login token for a known admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        payload: { email: ADMIN_EMAIL },
      });
      expect(res.statusCode).toBe(200);

      const rows = await pool.query<{ tokenHash: string }>(
        `SELECT "tokenHash" FROM "PlatformAdminLoginToken"
         WHERE "adminId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [adminId],
      );
      expect(rows.rows.length).toBe(1);
      // Stored at rest as a 64-char SHA-256 hex digest, never the raw token.
      expect(rows.rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns 200 for an unknown email without leaking existence (no token created)', async () => {
      const before = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAdminLoginToken"`,
      );
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        payload: { email: 'stranger@platform.test' },
      });
      expect(res.statusCode).toBe(200);

      const after = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAdminLoginToken"`,
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('supersedes prior unused tokens when a new link is requested', async () => {
      await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        payload: { email: ADMIN_EMAIL },
      });
      await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        payload: { email: ADMIN_EMAIL },
      });

      // Used tokens are deleted on consumption, so the only live token left for
      // the admin is the most recently issued one.
      const live = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAdminLoginToken" WHERE "adminId" = $1`,
        [adminId],
      );
      expect(live.rows[0]!.n).toBe(1);
    });

    it('returns 422 on an invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/request-link',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('POST /platform/auth/verify', () => {
    it('returns 200 with a working session token on a valid login token', async () => {
      const raw = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO "PlatformAdminLoginToken" ("tokenHash", "adminId", "expiresAt") VALUES ($1, $2, $3)`,
        [sha256hex(raw), adminId, new Date(Date.now() + 30 * 60 * 1_000)],
      );

      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/verify',
        payload: { token: raw },
      });
      expect(res.statusCode).toBe(200);
      const sessionToken = res.json<{ token: string }>().token;
      expect(sessionToken.length).toBeGreaterThan(0);

      // the minted session must authenticate a protected platform route
      const authed = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(authed.statusCode).toBe(200);

      // the login token must now be GONE (consumed by deletion, single-use)
      const remaining = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAdminLoginToken" WHERE "tokenHash" = $1`,
        [sha256hex(raw)],
      );
      expect(remaining.rows[0]!.n).toBe(0);

      // the session is stored hashed at rest — never the raw bearer token
      const session = await pool.query<{ tokenHash: string }>(
        `SELECT "tokenHash" FROM "PlatformAdminSession" WHERE "tokenHash" = $1`,
        [sha256hex(sessionToken)],
      );
      expect(session.rows.length).toBe(1);
      expect(session.rows[0]!.tokenHash).not.toBe(sessionToken);
    });

    it('records a platform.login audit row with the source IP', async () => {
      const raw = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO "PlatformAdminLoginToken" ("tokenHash", "adminId", "expiresAt") VALUES ($1, $2, $3)`,
        [sha256hex(raw), adminId, new Date(Date.now() + 30 * 60 * 1_000)],
      );
      await app.inject({
        method: 'POST',
        url: '/platform/auth/verify',
        remoteAddress: '10.1.2.3',
        payload: { token: raw },
      });

      const audit = await pool.query<{ adminId: string; ipAddress: string | null }>(
        `SELECT "adminId", "ipAddress" FROM "PlatformAuditLog"
         WHERE action = 'platform.login' AND "adminId" = $1 ORDER BY id DESC LIMIT 1`,
        [adminId],
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.ipAddress).toBe('10.1.2.3');
    });

    it('returns 401 on an expired token', async () => {
      const raw = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO "PlatformAdminLoginToken" ("tokenHash", "adminId", "expiresAt") VALUES ($1, $2, $3)`,
        [sha256hex(raw), adminId, new Date(Date.now() - 1_000)],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/verify',
        payload: { token: raw },
      });
      expect(res.statusCode).toBe(401);
    });

    it('is single-use: a second verify of the same token is rejected (double-spend)', async () => {
      const raw = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO "PlatformAdminLoginToken" ("tokenHash", "adminId", "expiresAt") VALUES ($1, $2, $3)`,
        [sha256hex(raw), adminId, new Date(Date.now() + 30 * 60 * 1_000)],
      );

      const first = await app.inject({
        method: 'POST',
        url: '/platform/auth/verify',
        payload: { token: raw },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/platform/auth/verify',
        payload: { token: raw },
      });
      expect(second.statusCode).toBe(401);
    });

    it('returns 401 on an unknown token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/auth/verify',
        payload: { token: 'a'.repeat(64) },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /platform/auth/logout', () => {
    it('clears the session: the token no longer authenticates and a logout audit row is written', async () => {
      const sessionToken = await freshSessionToken();

      const out = await app.inject({
        method: 'DELETE',
        url: '/platform/auth/logout',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(out.statusCode).toBe(204);

      // session row is gone
      const rows = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAdminSession" WHERE "tokenHash" = $1`,
        [sha256hex(sessionToken)],
      );
      expect(rows.rows[0]!.n).toBe(0);

      // the token no longer works
      const after = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(after.statusCode).toBe(401);

      const audit = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAuditLog"
         WHERE action = 'platform.logout' AND "adminId" = $1`,
        [adminId],
      );
      expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(1);
    });

    it('returns 401 when logging out without a session', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/platform/auth/logout' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('single active session', () => {
    it('a new login evicts the previous session for the same admin', async () => {
      const firstToken = await freshSessionToken();
      const secondToken = await freshSessionToken();

      // the older session is dead
      const old = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${firstToken}` },
      });
      expect(old.statusCode).toBe(401);

      // the newer session works
      const fresh = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${secondToken}` },
      });
      expect(fresh.statusCode).toBe(200);

      // exactly one live session row remains for the admin
      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PlatformAdminSession" WHERE "adminId" = $1`,
        [adminId],
      );
      expect(count.rows[0]!.n).toBe(1);
    });
  });

  describe('DB-only auth (no session cache)', () => {
    it('revokes instantly: deleting the session row 401s the very next request', async () => {
      const sessionToken = await freshSessionToken();

      // sanity: it works first
      const ok = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(ok.statusCode).toBe(200);

      // delete the row directly — no cache should serve a stale copy
      await pool.query(`DELETE FROM "PlatformAdminSession" WHERE "tokenHash" = $1`, [
        sha256hex(sessionToken),
      ]);

      const revoked = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(revoked.statusCode).toBe(401);
    });
  });

  describe('GET /platform/tenants', () => {
    it('returns 401 without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/platform/tenants' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 from a non-allowlisted IP even with a valid session', async () => {
      const sessionToken = await freshSessionToken();
      const res = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        remoteAddress: BLOCKED_IP,
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /platform/tenants', () => {
    it('creates a tenant + first ADMIN user + audit row in one transaction', async () => {
      const sessionToken = await freshSessionToken();
      const res = await app.inject({
        method: 'POST',
        url: '/platform/tenants',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'idempotency-key': crypto.randomBytes(16).toString('hex'),
        },
        payload: {
          tenant: { name: 'Globex Inc', slug: 'globex' },
          admin: { email: 'admin@globex.test', name: 'Globex Admin' },
        },
      });
      expect(res.statusCode).toBe(201);

      const tenant = await pool.query<{ id: string }>(
        `SELECT id FROM "Tenant" WHERE slug = 'globex'`,
      );
      expect(tenant.rows.length).toBe(1);
      const tenantId = tenant.rows[0]!.id;

      const user = await pool.query<{ role: string; isActive: boolean }>(
        `SELECT role, "isActive" FROM "User" WHERE email = 'admin@globex.test' AND "tenantId" = $1`,
        [tenantId],
      );
      expect(user.rows.length).toBe(1);
      expect(user.rows[0]!.role).toBe('ADMIN');

      const audit = await pool.query<{ actorType: string; actorId: string }>(
        `SELECT "actorType", "actorId" FROM "AuditLog"
         WHERE "tenantId" = $1 AND action = 'platform.tenant_created'
         ORDER BY id DESC LIMIT 1`,
        [tenantId],
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.actorType).toBe('PLATFORM_ADMIN');
      expect(audit.rows[0]!.actorId).toBe(adminId);

      // onboarding: the new admin's account has a system-generated password and
      // mustChangePassword = true so first login forces a password change
      const flagged = await pool.query<{ mustChangePassword: boolean }>(
        `SELECT "mustChangePassword" FROM "User" WHERE email = 'admin@globex.test'`,
      );
      expect(flagged.rows[0]!.mustChangePassword).toBe(true);
    });

    it('returns 409 on a duplicate tenant slug', async () => {
      const sessionToken = await freshSessionToken();
      const res = await app.inject({
        method: 'POST',
        url: '/platform/tenants',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'idempotency-key': crypto.randomBytes(16).toString('hex'),
        },
        payload: {
          tenant: { name: 'Globex Again', slug: 'globex' },
          admin: { email: 'other@globex.test', name: 'Other Admin' },
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 401 without a session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/platform/tenants',
        payload: {
          tenant: { name: 'NoAuth Co', slug: 'noauth' },
          admin: { email: 'admin@noauth.test', name: 'NoAuth Admin' },
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('replays the same response under a repeated Idempotency-Key without a second tenant', async () => {
      const sessionToken = await freshSessionToken();
      const idemKey = crypto.randomBytes(16).toString('hex');
      const payload = {
        tenant: { name: 'Initech', slug: 'initech' },
        admin: { email: 'admin@initech.test', name: 'Initech Admin' },
      };

      const first = await app.inject({
        method: 'POST',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${sessionToken}`, 'idempotency-key': idemKey },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${sessionToken}`, 'idempotency-key': idemKey },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);

      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Tenant" WHERE slug = 'initech'`,
      );
      expect(count.rows[0]!.n).toBe(1);
    });
  });

  describe('PATCH /platform/tenants/:id', () => {
    it('suspends a tenant (isActive=false) and writes an audit row', async () => {
      const sessionToken = await freshSessionToken();
      const created = await pool.query<{ id: string; publicId: string }>(
        `INSERT INTO "Tenant" (name, slug) VALUES ('Suspend Me', 'suspendme')
         RETURNING id, "publicId"`,
      );
      const { id: tenantId, publicId } = created.rows[0]!;

      const res = await app.inject({
        method: 'PATCH',
        url: `/platform/tenants/${publicId}`,
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'idempotency-key': crypto.randomBytes(16).toString('hex'),
        },
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(200);

      const tenant = await pool.query<{ isActive: boolean }>(
        `SELECT "isActive" FROM "Tenant" WHERE id = $1`,
        [tenantId],
      );
      expect(tenant.rows[0]!.isActive).toBe(false);

      const audit = await pool.query<{ actorType: string }>(
        `SELECT "actorType" FROM "AuditLog"
         WHERE "tenantId" = $1 AND action = 'platform.tenant_suspended'
         ORDER BY id DESC LIMIT 1`,
        [tenantId],
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]!.actorType).toBe('PLATFORM_ADMIN');
    });
  });
});
