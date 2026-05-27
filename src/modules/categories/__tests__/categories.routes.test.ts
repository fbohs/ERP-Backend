import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../prisma/migrations');

function loadMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((entry) => fs.statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

describe('categories routes', () => {
  let app: FastifyInstance;
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let adminToken: string;
  let inventoryManagerToken: string;

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

    const passwordHash = await argon2.hash('password123');

    await pool.query(
      `INSERT INTO "User" ("tenantId", email, name, password, role)
       VALUES ($1, 'admin@acme.com', 'Admin', $2, 'ADMIN')`,
      [tenantId, passwordHash],
    );
    await pool.query(
      `INSERT INTO "User" ("tenantId", email, name, password, role)
       VALUES ($1, 'inv@acme.com', 'Inv Manager', $2, 'INVENTORY_MANAGER')`,
      [tenantId, passwordHash],
    );

    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getFirstMappedPort()}`;
    app = await buildApp({
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl,
      queueRedisUrl: redisUrl,
    });
    await app.ready();

    const [adminLogin, invLogin] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@acme.com', password: 'password123' } }),
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'inv@acme.com', password: 'password123' } }),
    ]);
    adminToken = adminLogin.json<{ token: string }>().token;
    inventoryManagerToken = invLogin.json<{ token: string }>().token;
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([pgContainer.stop(), redisContainer.stop()]);
  });

  // ---------------------------------------------------------------------------
  // POST /categories
  // ---------------------------------------------------------------------------

  describe('POST /categories', () => {
    it('creates a root category and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Electronics', slug: 'electronics', description: 'All electronics' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; name: string; slug: string; parentId: null; isActive: boolean }>();
      expect(body.name).toBe('Electronics');
      expect(body.slug).toBe('electronics');
      expect(body.parentId).toBeNull();
      expect(body.isActive).toBe(true);

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'category.created' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('category.created');
    });

    it('creates a child category with parentId', async () => {
      const parentRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const electronics = parentRes.json<{ categories: { id: string; slug: string }[] }>()
        .categories.find((c) => c.slug === 'electronics')!;

      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Phones', slug: 'phones', parentId: electronics.id },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ parentId: string }>();
      expect(body.parentId).toBe(electronics.id);
    });

    it('returns 403 for non-ADMIN roles', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
        payload: { name: 'Clothing', slug: 'clothing' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 409 for duplicate slug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Electronics Again', slug: 'electronics' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CATEGORY_SLUG_EXISTS');
    });

    it('returns 401 without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        payload: { name: 'X', slug: 'x' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 422 for invalid slug format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Bad Slug', slug: 'Bad Slug!!!' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /categories
  // ---------------------------------------------------------------------------

  describe('GET /categories', () => {
    it('admin sees all categories including inactive', async () => {
      // Create then deactivate a category for this test
      const createRes = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'To Deactivate', slug: 'to-deactivate' },
      });
      const { id } = createRes.json<{ id: string }>();

      await app.inject({
        method: 'DELETE',
        url: `/categories/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { categories } = res.json<{ categories: { id: string; isActive: boolean }[] }>();
      const deactivated = categories.find((c) => c.id === id);
      expect(deactivated).toBeDefined();
      expect(deactivated!.isActive).toBe(false);
    });

    it('non-admin sees only active categories', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { categories } = res.json<{ categories: { isActive: boolean }[] }>();
      expect(categories.every((c) => c.isActive)).toBe(true);
    });

    it('returns 401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/categories' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /categories/:id
  // ---------------------------------------------------------------------------

  describe('GET /categories/:id', () => {
    it('returns the category', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const { categories } = listRes.json<{ categories: { id: string; slug: string }[] }>();
      const electronics = categories.find((c) => c.slug === 'electronics')!;

      const res = await app.inject({
        method: 'GET',
        url: `/categories/${electronics.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ slug: string }>().slug).toBe('electronics');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/categories/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('non-admin gets 404 for inactive category', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const inactive = listRes
        .json<{ categories: { id: string; isActive: boolean }[] }>()
        .categories.find((c) => !c.isActive)!;

      const res = await app.inject({
        method: 'GET',
        url: `/categories/${inactive.id}`,
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 422 for non-UUID id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/categories/not-a-uuid',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /categories/:id/children
  // ---------------------------------------------------------------------------

  describe('GET /categories/:id/children', () => {
    it('returns all descendants of a category', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const electronics = listRes
        .json<{ categories: { id: string; slug: string }[] }>()
        .categories.find((c) => c.slug === 'electronics')!;

      // Create a grandchild: Electronics → Phones → Android
      const phonesRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const phones = phonesRes
        .json<{ categories: { id: string; slug: string }[] }>()
        .categories.find((c) => c.slug === 'phones')!;

      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Android', slug: 'android', parentId: phones.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/categories/${electronics.id}/children`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { categories } = res.json<{ categories: { slug: string }[] }>();
      const slugs = categories.map((c) => c.slug);
      expect(slugs).toContain('phones');
      expect(slugs).toContain('android');
    });

    it('returns 404 for unknown parent id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/categories/${crypto.randomUUID()}/children`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /categories/:id
  // ---------------------------------------------------------------------------

  describe('PATCH /categories/:id', () => {
    it('updates name and description', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const electronics = listRes
        .json<{ categories: { id: string; slug: string }[] }>()
        .categories.find((c) => c.slug === 'electronics')!;

      const res = await app.inject({
        method: 'PATCH',
        url: `/categories/${electronics.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Consumer Electronics', description: 'Updated description' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ name: string; description: string }>();
      expect(body.name).toBe('Consumer Electronics');
      expect(body.description).toBe('Updated description');

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'category.updated' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('category.updated');
    });

    it('returns 409 on slug conflict', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const phones = listRes
        .json<{ categories: { id: string; slug: string }[] }>()
        .categories.find((c) => c.slug === 'phones')!;

      const res = await app.inject({
        method: 'PATCH',
        url: `/categories/${phones.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { slug: 'electronics' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CATEGORY_SLUG_EXISTS');
    });

    it('returns 409 on circular reparent', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const cats = listRes.json<{ categories: { id: string; slug: string }[] }>().categories;
      const electronics = cats.find((c) => c.slug === 'electronics')!;
      const android = cats.find((c) => c.slug === 'android')!;

      // Try to make Electronics a child of Android (its own grandchild)
      const res = await app.inject({
        method: 'PATCH',
        url: `/categories/${electronics.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { parentId: android.id },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CIRCULAR_CATEGORY_REFERENCE');
    });

    it('returns 403 for non-ADMIN', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const electronics = listRes
        .json<{ categories: { id: string; slug: string }[] }>()
        .categories.find((c) => c.slug === 'electronics')!;

      const res = await app.inject({
        method: 'PATCH',
        url: `/categories/${electronics.id}`,
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
        payload: { name: 'Hacked' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /categories/:id
  // ---------------------------------------------------------------------------

  describe('DELETE /categories/:id', () => {
    it('deactivates a category and returns 204', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'To Delete', slug: 'to-delete' },
      });
      const { id } = createRes.json<{ id: string }>();

      const res = await app.inject({
        method: 'DELETE',
        url: `/categories/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(204);

      const row = await pool.query<{ isActive: boolean }>(
        `SELECT "isActive" FROM "Category" WHERE "publicId" = $1`,
        [id],
      );
      expect(row.rows[0]!.isActive).toBe(false);

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'category.deactivated' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('category.deactivated');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/categories/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for non-ADMIN', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const cat = listRes.json<{ categories: { id: string }[] }>().categories[0]!;

      const res = await app.inject({
        method: 'DELETE',
        url: `/categories/${cat.id}`,
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  describe('Idempotency-Key on POST /categories', () => {
    it('replays the stored response without creating a duplicate', async () => {
      const key = crypto.randomBytes(16).toString('hex');
      const payload = { name: `Idem-${key}`, slug: `idem-${key}` };

      const first = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);

      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Category" WHERE slug = $1`,
        [payload.slug],
      );
      expect(count.rows[0]!.n).toBe(1);
    });
  });
});
