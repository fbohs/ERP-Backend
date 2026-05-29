import type { FastifyPluginAsync } from 'fastify';
import { ProductsRepository } from './products.repository.js';
import { ProductsService } from './products.service.js';
import { AuditRepository } from '../../shared/audit/index.js';
import { createAuthenticate, authorize } from '../../shared/auth/index.js';
import { createIdempotency } from '../../shared/idempotency/index.js';
import { ValidationError } from '../../shared/errors/base.js';
import {
  CreateProductBodySchema,
  UpdateProductBodySchema,
  UpdateVariantBodySchema,
  ProductParamsSchema,
  VariantParamsSchema,
  ListProductsQuerySchema,
} from './products.schemas.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

interface ProductsPluginOptions {
  db: AppDb;
  redis: Redis;
  queueRedis: Redis;
}

const errorSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const variantSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sku: { type: 'string' },
    listPrice: { type: 'string' },
    compareAtPrice: { type: ['string', 'null'] },
    standardCost: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const productListSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sku: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: ['string', 'null'] },
    type: { type: 'string', enum: ['GOODS', 'SERVICE'] },
    status: { type: 'string', enum: ['DRAFT', 'READY', 'DISCONTINUED', 'ARCHIVED'] },
    categoryId: { type: 'string', format: 'uuid' },
    uomCode: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    hsnCode: { type: ['string', 'null'] },
    isPublished: { type: 'boolean' },
    isSuspendedByOperator: { type: 'boolean' },
    verificationStatus: {
      type: 'string',
      enum: ['UNVERIFIED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'FLAGGED'],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const productSchema = {
  ...productListSchema,
  properties: {
    ...productListSchema.properties,
    variants: { type: 'array', items: variantSchema },
  },
} as const;

export const productsPlugin: FastifyPluginAsync<ProductsPluginOptions> = async (app, opts) => {
  const repo = new ProductsRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const service = new ProductsService(repo, auditRepo, opts.db);
  const authenticate = createAuthenticate(opts.db, opts.redis);
  const idempotency = createIdempotency(opts.queueRedis);

  // ---------------------------------------------------------------------------
  // POST /products
  // ---------------------------------------------------------------------------
  app.post(
    '/products',
    {
      schema: {
        tags: ['Products'],
        summary: 'Create a product with a default variant',
        description:
          'Creates a Product + one default ProductVariant. ' +
          'uomCode must match a seeded UnitOfMeasure code (EA, KG, G, LTR, M, BOX, etc.). ' +
          'slug is auto-generated from name if omitted.',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['name', 'sku', 'categoryId', 'uomCode', 'listPrice'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            sku: { type: 'string', minLength: 1, maxLength: 100 },
            categoryId: { type: 'string', format: 'uuid' },
            uomCode: { type: 'string', minLength: 1, maxLength: 20 },
            listPrice: { type: 'string' },
            slug: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: ['string', 'null'], maxLength: 2000 },
            type: { type: 'string', enum: ['GOODS', 'SERVICE'] },
            tags: { type: 'array', items: { type: 'string' } },
            hsnCode: { type: ['string', 'null'], maxLength: 20 },
            variantSku: { type: 'string', minLength: 1, maxLength: 100 },
            compareAtPrice: { type: ['string', 'null'] },
          },
        },
        response: {
          201: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          409: { ...errorSchema, description: 'PRODUCT_SKU_EXISTS or PRODUCT_SLUG_EXISTS or VARIANT_SKU_EXISTS' },
          422: { ...errorSchema, description: 'Validation error or invalid categoryId / uomCode' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const parsed = CreateProductBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid request body');
      const result = await service.create(parsed.data, request.user, request.id);
      return reply.status(201).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /products
  // ---------------------------------------------------------------------------
  app.get(
    '/products',
    {
      schema: {
        tags: ['Products'],
        summary: 'List products',
        description: 'Returns all products in the tenant. Filter by status or categoryId.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['DRAFT', 'READY', 'DISCONTINUED', 'ARCHIVED'] },
            categoryId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: { products: { type: 'array', items: productListSchema } },
          },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
        },
      },
      preHandler: [authenticate, authorize('product:read')],
    },
    async (request, reply) => {
      const query = ListProductsQuerySchema.safeParse(request.query);
      if (!query.success) throw new ValidationError('Invalid query parameters');
      const isAdmin = request.user.role === 'ADMIN';
      const filters: { status?: string; categoryId?: string } = {};
      if (query.data.status !== undefined) filters.status = query.data.status;
      if (query.data.categoryId !== undefined) filters.categoryId = query.data.categoryId;
      const products = await service.list(request.user.tenantId, filters, isAdmin);
      return reply.status(200).send({ products });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /products/:id
  // ---------------------------------------------------------------------------
  app.get(
    '/products/:id',
    {
      schema: {
        tags: ['Products'],
        summary: 'Get a single product with its variants',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
          422: { ...errorSchema, description: 'Invalid id format' },
        },
      },
      preHandler: [authenticate, authorize('product:read')],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const isAdmin = request.user.role === 'ADMIN';
      const product = await service.get(params.data.id, request.user.tenantId, isAdmin);
      return reply.status(200).send(product);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /products/:id
  // ---------------------------------------------------------------------------
  app.patch(
    '/products/:id',
    {
      schema: {
        tags: ['Products'],
        summary: 'Update a product',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            sku: { type: 'string', minLength: 1, maxLength: 100 },
            slug: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: ['string', 'null'], maxLength: 2000 },
            type: { type: 'string', enum: ['GOODS', 'SERVICE'] },
            status: { type: 'string', enum: ['DRAFT', 'READY', 'DISCONTINUED', 'ARCHIVED'] },
            categoryId: { type: 'string', format: 'uuid' },
            uomCode: { type: 'string', minLength: 1, maxLength: 20 },
            tags: { type: 'array', items: { type: 'string' } },
            hsnCode: { type: ['string', 'null'], maxLength: 20 },
          },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
          409: { ...errorSchema, description: 'PRODUCT_SKU_EXISTS or PRODUCT_SLUG_EXISTS' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const parsed = UpdateProductBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid request body');
      const result = await service.update(params.data.id, parsed.data, request.user, request.id);
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /products/:id/variants/:variantId
  // ---------------------------------------------------------------------------
  app.patch(
    '/products/:id/variants/:variantId',
    {
      schema: {
        tags: ['Products'],
        summary: 'Update a product variant',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        params: {
          type: 'object',
          required: ['id', 'variantId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            variantId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            sku: { type: 'string', minLength: 1, maxLength: 100 },
            listPrice: { type: 'string' },
            compareAtPrice: { type: ['string', 'null'] },
            standardCost: { type: ['string', 'null'] },
            isActive: { type: 'boolean' },
          },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product or variant not found' },
          409: { ...errorSchema, description: 'VARIANT_SKU_EXISTS' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = VariantParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid params');
      const parsed = UpdateVariantBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid request body');
      const result = await service.updateVariant(
        params.data.id,
        params.data.variantId,
        parsed.data,
        request.user,
        request.id,
      );
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /products/:id/publish
  // ---------------------------------------------------------------------------
  app.post(
    '/products/:id/publish',
    {
      schema: {
        tags: ['Products'],
        summary: 'Publish a product',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const result = await service.publish(params.data.id, request.user, request.id);
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /products/:id/unpublish
  // ---------------------------------------------------------------------------
  app.post(
    '/products/:id/unpublish',
    {
      schema: {
        tags: ['Products'],
        summary: 'Unpublish a product',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const result = await service.unpublish(params.data.id, request.user, request.id);
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /products/:id/suspend
  // ---------------------------------------------------------------------------
  app.post(
    '/products/:id/suspend',
    {
      schema: {
        tags: ['Products'],
        summary: 'Suspend a product (ADMIN only)',
        description: 'Sets isSuspendedByOperator = true. Only ADMIN role can call this.',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'ADMIN role required' },
          404: { ...errorSchema, description: 'Product not found' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const result = await service.suspend(params.data.id, request.user, request.id);
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /products/:id/unsuspend
  // ---------------------------------------------------------------------------
  app.post(
    '/products/:id/unsuspend',
    {
      schema: {
        tags: ['Products'],
        summary: 'Unsuspend a product (ADMIN only)',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'ADMIN role required' },
          404: { ...errorSchema, description: 'Product not found' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const result = await service.unsuspend(params.data.id, request.user, request.id);
      return reply.status(200).send(result);
    },
  );
};
