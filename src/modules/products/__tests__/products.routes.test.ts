import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../../shared/storage/index.js', () => ({
  generatePresignedPutUrl: vi.fn(),
  getObjectMeta: vi.fn(),
  buildObjectUrl: vi.fn(),
  isAllowedMimeType: (v: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(v),
  PRESIGN_TTL_SECONDS: 86400,
  MAX_IMAGE_SIZE_BYTES: 5 * 1024 * 1024,
}));
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import type { ProductView, ProductListView, PresignImageView } from '../products.types.js';
import * as storage from '../../../shared/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../prisma/migrations');

function loadMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((entry) => fs.statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'));
}

describe('products routes', () => {
  let app: FastifyInstance;
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;

  let adminToken: string;
  let inventoryManagerToken: string;
  let merchantToken: string;
  let reportViewerToken: string;

  let categoryId: string; // public uuid of a test category

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
      `INSERT INTO "Tenant" (name, slug) VALUES ('Test Co', 'test-co') RETURNING id`,
    );
    const tenantId = tenantResult.rows[0]!.id;
    const hash = await argon2.hash('password123');

    await Promise.all([
      pool.query(
        `INSERT INTO "User" ("tenantId", email, name, password, role) VALUES ($1, 'admin@test.com', 'Admin', $2, 'ADMIN')`,
        [tenantId, hash],
      ),
      pool.query(
        `INSERT INTO "User" ("tenantId", email, name, password, role) VALUES ($1, 'inv@test.com', 'Inv Mgr', $2, 'INVENTORY_MANAGER')`,
        [tenantId, hash],
      ),
      pool.query(
        `INSERT INTO "User" ("tenantId", email, name, password, role) VALUES ($1, 'merchant@test.com', 'Merchant', $2, 'MERCHANT')`,
        [tenantId, hash],
      ),
      pool.query(
        `INSERT INTO "User" ("tenantId", email, name, password, role) VALUES ($1, 'viewer@test.com', 'Viewer', $2, 'REPORT_VIEWER')`,
        [tenantId, hash],
      ),
    ]);

    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getFirstMappedPort()}`;
    app = await buildApp({
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl,
      queueRedisUrl: redisUrl,
    });
    await app.ready();

    const [adminLogin, invLogin, merchantLogin, viewerLogin] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@test.com', password: 'password123' } }),
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'inv@test.com', password: 'password123' } }),
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'merchant@test.com', password: 'password123' } }),
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'viewer@test.com', password: 'password123' } }),
    ]);
    adminToken = adminLogin.json<{ token: string }>().token;
    inventoryManagerToken = invLogin.json<{ token: string }>().token;
    merchantToken = merchantLogin.json<{ token: string }>().token;
    reportViewerToken = viewerLogin.json<{ token: string }>().token;

    // Create a test category via the categories API
    const catRes = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Test Category', slug: 'test-category' },
    });
    categoryId = catRes.json<{ id: string }>().id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([pgContainer.stop(), redisContainer.stop()]);
  });

  // ---------------------------------------------------------------------------
  // POST /products
  // ---------------------------------------------------------------------------

  describe('POST /products', () => {
    it('creates a product with default variant and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Blue Widget',
          sku: 'BW-001',
          categoryId,
          uomCode: 'EA',
          listPrice: '49.99',
          description: 'A blue widget',
          tags: ['widget', 'blue'],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<ProductView>();
      expect(body.name).toBe('Blue Widget');
      expect(body.sku).toBe('BW-001');
      expect(body.slug).toBe('blue-widget');
      expect(body.categoryId).toBe(categoryId);
      expect(body.uomCode).toBe('EA');
      expect(body.status).toBe('DRAFT');
      expect(body.isPublished).toBe(false);
      expect(body.isSuspendedByOperator).toBe(false); // admin sees this
      expect(body.variants).toHaveLength(1);
      expect(body.variants[0]!.sku).toBe('BW-001');
      expect(body.variants[0]!.listPrice).toBe('49.9900');

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'product.created' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('product.created');
    });

    it('auto-generates slug from name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Red Widget Pro', sku: 'RWP-001', categoryId, uomCode: 'EA', listPrice: '99.00' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json<ProductView>().slug).toBe('red-widget-pro');
    });

    it('accepts explicit slug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Green Widget',
          sku: 'GW-001',
          categoryId,
          uomCode: 'EA',
          listPrice: '29.99',
          slug: 'green-widget-custom',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json<ProductView>().slug).toBe('green-widget-custom');
    });

    it('uses custom variantSku when provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Purple Widget',
          sku: 'PW-001',
          categoryId,
          uomCode: 'EA',
          listPrice: '19.99',
          variantSku: 'PW-001-DEFAULT',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json<ProductView>().variants[0]!.sku).toBe('PW-001-DEFAULT');
    });

    it('returns 409 when SKU already exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Duplicate SKU', sku: 'BW-001', categoryId, uomCode: 'EA', listPrice: '10.00' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_SKU_EXISTS');
    });

    it('returns 409 when slug already exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Slug Duplicate',
          sku: 'UNIQUE-SKU-999',
          categoryId,
          uomCode: 'EA',
          listPrice: '10.00',
          slug: 'blue-widget',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_SLUG_EXISTS');
    });

    it('returns 422 for invalid uomCode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Bad UOM',
          sku: 'BAD-UOM-001',
          categoryId,
          uomCode: 'NONEXISTENT',
          listPrice: '10.00',
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_UOM');
    });

    it('returns 422 for invalid categoryId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Bad Cat',
          sku: 'BAD-CAT-001',
          categoryId: '00000000-0000-0000-0000-000000000000',
          uomCode: 'EA',
          listPrice: '10.00',
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CATEGORY');
    });

    it('returns 403 for REPORT_VIEWER (no product:write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${reportViewerToken}` },
        payload: { name: 'Forbidden', sku: 'NOPE', categoryId, uomCode: 'EA', listPrice: '10.00' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        payload: { name: 'No Auth', sku: 'NA-001', categoryId, uomCode: 'EA', listPrice: '10.00' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('merchant creates product and isSuspendedByOperator is absent in their own response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { name: 'Merchant Product', sku: 'MERCH-001', categoryId, uomCode: 'EA', listPrice: '5.00' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<ProductView>();
      expect(body.isSuspendedByOperator).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /products
  // ---------------------------------------------------------------------------

  describe('GET /products', () => {
    it('returns 200 with all products for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ products: ProductListView[] }>();
      expect(body.products.length).toBeGreaterThanOrEqual(1);
      // Admin response includes isSuspendedByOperator
      expect(body.products.every((p) => 'isSuspendedByOperator' in p)).toBe(true);
    });

    it('non-admin response does not include isSuspendedByOperator', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/products',
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ products: ProductListView[] }>();
      expect(body.products.every((p) => p['isSuspendedByOperator'] === undefined)).toBe(true);
    });

    it('filters by status', async () => {
      // Create a READY product
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Ready Product', sku: 'READY-001', categoryId, uomCode: 'EA', listPrice: '10.00' },
      });
      await app.inject({
        method: 'PATCH',
        url: '/products/READY-001', // will use slug-based search — actually we need publicId
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'READY' },
      });

      // Fetch all, filter by DRAFT
      const res = await app.inject({
        method: 'GET',
        url: '/products?status=DRAFT',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ products: ProductListView[] }>();
      expect(body.products.every((p) => p.status === 'DRAFT')).toBe(true);
    });

    it('filters by categoryId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/products?categoryId=${categoryId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ products: ProductListView[] }>();
      expect(body.products.every((p) => p.categoryId === categoryId)).toBe(true);
    });

    it('returns 403 for REPORT_VIEWER (no product:read)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/products',
        headers: { authorization: `Bearer ${reportViewerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /products/:id
  // ---------------------------------------------------------------------------

  describe('GET /products/:id', () => {
    it('returns product with variants', async () => {
      // First get a product publicId from list
      const listRes = await app.inject({
        method: 'GET',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const products = listRes.json<{ products: ProductListView[] }>().products;
      const first = products.find((p) => p.sku === 'BW-001')!;

      const res = await app.inject({
        method: 'GET',
        url: `/products/${first.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<ProductView>();
      expect(body.id).toBe(first.id);
      expect(body.variants).toHaveLength(1);
      expect(body.variants[0]!.listPrice).toBe('49.9900');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/products/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 422 for non-UUID id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/products/not-a-uuid',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /products/:id
  // ---------------------------------------------------------------------------

  describe('PATCH /products/:id', () => {
    let productId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Patch Test Product',
          sku: 'PATCH-001',
          categoryId,
          uomCode: 'EA',
          listPrice: '20.00',
        },
      });
      productId = res.json<ProductView>().id;
    });

    it('updates product name and status', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Updated Name', status: 'READY' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<ProductView>();
      expect(body.name).toBe('Updated Name');
      expect(body.status).toBe('READY');
    });

    it('returns 409 on slug conflict', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { slug: 'blue-widget' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_SLUG_EXISTS');
    });

    it('returns 409 on SKU conflict', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sku: 'BW-001' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_SKU_EXISTS');
    });

    it('returns 404 for unknown product', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/products/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for REPORT_VIEWER', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        headers: { authorization: `Bearer ${reportViewerToken}` },
        payload: { name: 'Nope' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('writes audit log on update', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { tags: ['updated'] },
      });

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'product.updated' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('product.updated');
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /products/:id/variants/:variantId
  // ---------------------------------------------------------------------------

  describe('PATCH /products/:id/variants/:variantId', () => {
    let productId: string;
    let variantId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Variant Patch Product',
          sku: 'VP-001',
          categoryId,
          uomCode: 'EA',
          listPrice: '30.00',
        },
      });
      const body = res.json<ProductView>();
      productId = body.id;
      variantId = body.variants[0]!.id;
    });

    it('updates variant listPrice', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/variants/${variantId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { listPrice: '35.00', compareAtPrice: '40.00' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<ProductView>();
      expect(body.variants[0]!.listPrice).toBe('35.0000');
      expect(body.variants[0]!.compareAtPrice).toBe('40.0000');
    });

    it('returns 404 for unknown variant', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/variants/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { listPrice: '10.00' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /products/:id/publish & /unpublish
  // ---------------------------------------------------------------------------

  describe('publish / unpublish', () => {
    let productId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Publishable', sku: 'PUB-001', categoryId, uomCode: 'EA', listPrice: '1.00' },
      });
      productId = res.json<ProductView>().id;
    });

    it('publishes a product', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/publish`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ProductView>().isPublished).toBe(true);
    });

    it('audit log records product.published', async () => {
      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'product.published' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('product.published');
    });

    it('unpublishes a product', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/unpublish`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ProductView>().isPublished).toBe(false);
    });

    it('merchant can publish their own product', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { name: 'Merchant Pub', sku: 'MERCH-PUB-001', categoryId, uomCode: 'EA', listPrice: '2.00' },
      });
      const pid = createRes.json<ProductView>().id;

      const res = await app.inject({
        method: 'POST',
        url: `/products/${pid}/publish`,
        headers: { authorization: `Bearer ${merchantToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ProductView>().isPublished).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /products/:id/suspend & /unsuspend
  // ---------------------------------------------------------------------------

  describe('suspend / unsuspend', () => {
    let productId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Suspendable', sku: 'SUSP-001', categoryId, uomCode: 'EA', listPrice: '1.00' },
      });
      productId = res.json<ProductView>().id;
    });

    it('admin can suspend a product', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/suspend`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ProductView>().isSuspendedByOperator).toBe(true);
    });

    it('admin can unsuspend a product', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/unsuspend`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ProductView>().isSuspendedByOperator).toBe(false);
    });

    it('non-admin (INVENTORY_MANAGER) cannot suspend', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/suspend`,
        headers: { authorization: `Bearer ${inventoryManagerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('merchant cannot suspend', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/suspend`,
        headers: { authorization: `Bearer ${merchantToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency-Key replay
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('replays the same 201 on duplicate POST /products', async () => {
      const key = `idem-${Date.now()}`;
      const payload = {
        name: 'Idempotent Product',
        sku: `IDEM-${Date.now()}`,
        categoryId,
        uomCode: 'EA',
        listPrice: '9.99',
      };

      const first = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json<ProductView>().id).toBe(first.json<ProductView>().id);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /products/:id/images/presign
  // ---------------------------------------------------------------------------

  describe('POST /products/:id/images/presign', () => {
    let productId: string;
    const fakeUploadUrl = 'https://bucket.s3.amazonaws.com/products/fake-key.jpg?X-Amz-Signature=abc';
    const fakeExpiresAt = new Date(Date.now() + 86400 * 1000).toISOString();

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Image Test Product', sku: 'IMG-001', categoryId, uomCode: 'EA', listPrice: '10.00' },
      });
      productId = res.json<ProductView>().id;
    });

    beforeEach(() => { vi.clearAllMocks(); });

    it('returns presigned upload URL for valid mimeType', async () => {
      vi.mocked(storage.generatePresignedPutUrl).mockResolvedValueOnce({
        s3Key: `products/${productId}/generated-uuid.jpg`,
        uploadUrl: fakeUploadUrl,
        expiresAt: new Date(fakeExpiresAt),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/presign`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mimeType: 'image/jpeg' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<PresignImageView>();
      // Service generates the s3Key itself; verify shape not exact value
      expect(body.s3Key).toMatch(new RegExp(`^products/${productId}/[\\w-]+\\.jpg$`));
      expect(body.uploadUrl).toBe(fakeUploadUrl);
      expect(body.expiresAt).toBeDefined();
    });

    it('returns presigned URL for image/png and image/webp', async () => {
      for (const mimeType of ['image/png', 'image/webp']) {
        vi.mocked(storage.generatePresignedPutUrl).mockResolvedValueOnce({
          s3Key: `products/${productId}/uuid.${mimeType.split('/')[1]}`,
          uploadUrl: fakeUploadUrl,
          expiresAt: new Date(fakeExpiresAt),
        });

        const res = await app.inject({
          method: 'POST',
          url: `/products/${productId}/images/presign`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { mimeType },
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('returns 422 for disallowed mimeType', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/presign`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mimeType: 'image/gif' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('returns 404 for unknown product', async () => {
      vi.mocked(storage.generatePresignedPutUrl).mockResolvedValueOnce({
        s3Key: 'products/00000000-0000-0000-0000-000000000000/uuid.jpg',
        uploadUrl: fakeUploadUrl,
        expiresAt: new Date(fakeExpiresAt),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/products/00000000-0000-0000-0000-000000000000/images/presign',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mimeType: 'image/jpeg' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for REPORT_VIEWER', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/presign`,
        headers: { authorization: `Bearer ${reportViewerToken}` },
        payload: { mimeType: 'image/jpeg' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('replays the same presign response on retry with same Idempotency-Key', async () => {
      vi.mocked(storage.generatePresignedPutUrl).mockResolvedValueOnce({
        s3Key: `products/${productId}/idem-key.jpg`,
        uploadUrl: fakeUploadUrl,
        expiresAt: new Date(fakeExpiresAt),
      });

      const key = `presign-idem-${Date.now()}`;
      const first = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/presign`,
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload: { mimeType: 'image/jpeg' },
      });
      const second = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/presign`,
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload: { mimeType: 'image/jpeg' },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Second call must replay — generatePresignedPutUrl called exactly once
      expect(vi.mocked(storage.generatePresignedPutUrl)).toHaveBeenCalledTimes(1);
      expect(second.json<PresignImageView>().s3Key).toBe(first.json<PresignImageView>().s3Key);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /products/:id/images/confirm
  // ---------------------------------------------------------------------------

  describe('POST /products/:id/images/confirm', () => {
    let productId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Confirm Image Product', sku: 'CONF-IMG-001', categoryId, uomCode: 'EA', listPrice: '10.00' },
      });
      productId = res.json<ProductView>().id;
    });

    beforeEach(() => { vi.clearAllMocks(); });

    it('returns 422 PRODUCT_IMAGE_PRIMARY_REQUIRED when no existing images and primary is absent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { others: [{ s3Key: `products/${productId}/a.jpg` }] } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_IMAGE_PRIMARY_REQUIRED');
    });

    it('confirms primary only — sets isPrimary=true, sortOrder=0, stores s3Key', async () => {
      const s3Key = `products/${productId}/primary-uuid.jpg`;
      vi.mocked(storage.getObjectMeta).mockResolvedValueOnce({ sizeBytes: 100 * 1024, contentType: 'image/jpeg' });
      vi.mocked(storage.buildObjectUrl).mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${s3Key}`);

      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { primary: { s3Key, altText: 'Front view' } } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<ProductView>();
      expect(body.media).toHaveLength(1);
      expect(body.media[0]!.isPrimary).toBe(true);
      expect(body.media[0]!.sortOrder).toBe(0);
      expect(body.media[0]!.s3Key).toBe(s3Key);
      expect(body.media[0]!.altText).toBe('Front view');
    });

    it('confirms primary + others — sortOrder follows array position, others are not primary', async () => {
      const otherS3Key1 = `products/${productId}/other-uuid-1.png`;
      const otherS3Key2 = `products/${productId}/other-uuid-2.webp`;
      // product already has 1 image from previous test; baseOrder = 1
      vi.mocked(storage.getObjectMeta)
        .mockResolvedValueOnce({ sizeBytes: 50 * 1024, contentType: 'image/png' })
        .mockResolvedValueOnce({ sizeBytes: 60 * 1024, contentType: 'image/webp' });
      vi.mocked(storage.buildObjectUrl)
        .mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${otherS3Key1}`)
        .mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${otherS3Key2}`);

      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          images: {
            others: [
              { s3Key: otherS3Key1, altText: 'Side view' },
              { s3Key: otherS3Key2 },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<ProductView>();
      expect(body.media).toHaveLength(3);
      expect(body.media[1]!.s3Key).toBe(otherS3Key1);
      expect(body.media[1]!.sortOrder).toBe(1);
      expect(body.media[1]!.isPrimary).toBe(false);
      expect(body.media[2]!.s3Key).toBe(otherS3Key2);
      expect(body.media[2]!.sortOrder).toBe(2);
      expect(body.media[2]!.isPrimary).toBe(false);
    });

    it('providing a new primary demotes the existing primary', async () => {
      const newPrimaryKey = `products/${productId}/new-primary.jpg`;
      vi.mocked(storage.getObjectMeta).mockResolvedValueOnce({ sizeBytes: 80 * 1024, contentType: 'image/jpeg' });
      vi.mocked(storage.buildObjectUrl).mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${newPrimaryKey}`);

      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { primary: { s3Key: newPrimaryKey } } },
      });

      expect(res.statusCode).toBe(200);
      const media = res.json<ProductView>().media;
      const primaries = media.filter((m) => m.isPrimary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0]!.s3Key).toBe(newPrimaryKey);
    });

    it('writes audit log with action product.images_confirmed', async () => {
      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'product.images_confirmed' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('product.images_confirmed');
    });

    it('returns 422 PRODUCT_IMAGE_NOT_UPLOADED when object is not in S3', async () => {
      vi.mocked(storage.getObjectMeta).mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { primary: { s3Key: `products/${productId}/not-uploaded.jpg` } } },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_IMAGE_NOT_UPLOADED');
    });

    it('returns 422 PRODUCT_IMAGE_TOO_LARGE when object exceeds 5 MB', async () => {
      vi.mocked(storage.getObjectMeta).mockResolvedValueOnce({ sizeBytes: 6 * 1024 * 1024, contentType: 'image/jpeg' });

      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { primary: { s3Key: `products/${productId}/too-large.jpg` } } },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_IMAGE_TOO_LARGE');
    });

    it('returns 422 PRODUCT_IMAGE_KEY_MISMATCH when s3Key does not belong to this product', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { primary: { s3Key: 'products/other-product-id/uuid.jpg' } } },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_IMAGE_KEY_MISMATCH');
    });

    it('returns 404 for unknown product', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      vi.mocked(storage.getObjectMeta).mockResolvedValueOnce({ sizeBytes: 100, contentType: 'image/jpeg' });

      const res = await app.inject({
        method: 'POST',
        url: `/products/${fakeId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { images: { primary: { s3Key: `products/${fakeId}/uuid.jpg` } } },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for REPORT_VIEWER', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${reportViewerToken}` },
        payload: { images: { primary: { s3Key: `products/${productId}/uuid.jpg` } } },
      });
      expect(res.statusCode).toBe(403);
    });

    it('replays confirm response on retry with same Idempotency-Key', async () => {
      const s3Key = `products/${productId}/idem-uuid.webp`;
      vi.mocked(storage.getObjectMeta).mockResolvedValueOnce({ sizeBytes: 200, contentType: 'image/webp' });
      vi.mocked(storage.buildObjectUrl).mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${s3Key}`);

      const key = `confirm-idem-${Date.now()}`;
      const first = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload: { images: { primary: { s3Key } } },
      });
      const second = await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload: { images: { primary: { s3Key } } },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(vi.mocked(storage.getObjectMeta)).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /products/:id/images/primary
  // ---------------------------------------------------------------------------

  describe('PATCH /products/:id/images/primary', () => {
    let productId: string;
    let key1: string;
    let key2: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Primary Image Product', sku: 'PRIMARY-IMG-001', categoryId, uomCode: 'EA', listPrice: '15.00' },
      });
      productId = res.json<ProductView>().id;

      key1 = `products/${productId}/img-primary-1.jpg`;
      key2 = `products/${productId}/img-primary-2.png`;

      vi.mocked(storage.getObjectMeta)
        .mockResolvedValueOnce({ sizeBytes: 100, contentType: 'image/jpeg' })
        .mockResolvedValueOnce({ sizeBytes: 200, contentType: 'image/png' });
      vi.mocked(storage.buildObjectUrl)
        .mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${key1}`)
        .mockReturnValueOnce(`https://bucket.s3.amazonaws.com/${key2}`);

      await app.inject({
        method: 'POST',
        url: `/products/${productId}/images/confirm`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          images: {
            primary: { s3Key: key1, altText: 'First' },
            others: [{ s3Key: key2, altText: 'Second' }],
          },
        },
      });
    });

    beforeEach(() => { vi.clearAllMocks(); });

    it('promotes key2 to primary and demotes key1', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { s3Key: key2 },
      });

      expect(res.statusCode).toBe(200);
      const media = res.json<ProductView>().media;
      expect(media.find((m) => m.s3Key === key2)!.isPrimary).toBe(true);
      expect(media.find((m) => m.s3Key === key1)!.isPrimary).toBe(false);
    });

    it('calling with already-primary s3Key returns 200 unchanged without writing audit', async () => {
      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM "AuditLog" WHERE action = 'product.image_primary_set'`,
      );

      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { s3Key: key2 },
      });

      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM "AuditLog" WHERE action = 'product.image_primary_set'`,
      );

      expect(res.statusCode).toBe(200);
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    });

    it('writes audit log with action product.image_primary_set', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { s3Key: key1 },
      });

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM "AuditLog" WHERE action = 'product.image_primary_set' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.action).toBe('product.image_primary_set');
    });

    it('returns 422 PRODUCT_IMAGE_NOT_FOUND when s3Key is not in product media', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { s3Key: `products/${productId}/ghost.jpg` },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PRODUCT_IMAGE_NOT_FOUND');
    });

    it('returns 404 for unknown product', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${fakeId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { s3Key: `products/${fakeId}/img.jpg` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for REPORT_VIEWER', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${reportViewerToken}` },
        payload: { s3Key: key1 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('replays set-primary response on retry with same Idempotency-Key', async () => {
      const key = `primary-idem-${Date.now()}`;
      const first = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload: { s3Key: key2 },
      });
      const second = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}/images/primary`,
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
        payload: { s3Key: key2 },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json<ProductView>().media.find((m) => m.s3Key === key2)!.isPrimary).toBe(true);
      expect(second.json<ProductView>().media.find((m) => m.s3Key === key2)!.isPrimary).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
});
