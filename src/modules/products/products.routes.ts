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

const mediaEntrySchema = {
  type: 'object',
  properties: {
    s3Key: { type: 'string' },
    url: { type: 'string' },
    altText: { type: ['string', 'null'] },
    mediaType: { type: 'string' },
    sortOrder: { type: 'number' },
    isPrimary: { type: 'boolean' },
  },
} as const;

const productSchema = {
  ...productListSchema,
  properties: {
    ...productListSchema.properties,
    variants: { type: 'array', items: variantSchema },
    media: { type: 'array', items: mediaEntrySchema },
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

  // ---------------------------------------------------------------------------
  // POST /products/:id/images/presign
  // ---------------------------------------------------------------------------
  app.post(
    '/products/:id/images/presign',
    {
      schema: {
        tags: ['Products'],
        summary: 'Request a presigned S3 upload URL for a product image',
        description:
          'Returns a presigned PUT URL the client uses to upload directly to S3. ' +
          'The URL and s3Key are cached for 24 hours — retry with the same Idempotency-Key ' +
          'to recover the same URL without generating a new one. ' +
          'Call POST /products/:id/images/confirm after a successful upload.',
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
          required: ['mimeType'],
          properties: {
            mimeType: {
              type: 'string',
              enum: ['image/jpeg', 'image/png', 'image/webp'],
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              s3Key: { type: 'string' },
              uploadUrl: { type: 'string' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
          422: { ...errorSchema, description: 'Invalid mimeType' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const body = request.body as { mimeType: string };
      const result = await service.presignImageUpload(params.data.id, body.mimeType, request.user);
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /products/:id/images/confirm
  // ---------------------------------------------------------------------------
  app.post(
    '/products/:id/images/confirm',
    {
      schema: {
        tags: ['Products'],
        summary: 'Confirm one or more product image uploads and persist them',
        description:
          'Verifies each s3Key exists in S3 (max 5 MB each) and appends the images to the product media list. ' +
          'images.primary designates the new primary image and demotes any existing one. ' +
          'images.primary is required if the product has no existing images. ' +
          'images.others are appended in array order after images.primary. ' +
          'sortOrder is derived from array position — do not send it explicitly.',
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
          required: ['images'],
          properties: {
            images: {
              type: 'object',
              properties: {
                primary: {
                  type: 'object',
                  required: ['s3Key'],
                  properties: {
                    s3Key: { type: 'string', minLength: 1 },
                    altText: { type: ['string', 'null'], maxLength: 255 },
                  },
                },
                others: {
                  type: 'array',
                  maxItems: 9,
                  items: {
                    type: 'object',
                    required: ['s3Key'],
                    properties: {
                      s3Key: { type: 'string', minLength: 1 },
                      altText: { type: ['string', 'null'], maxLength: 255 },
                    },
                  },
                },
              },
            },
          },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
          422: {
            ...errorSchema,
            description:
              'PRODUCT_IMAGE_NOT_UPLOADED | PRODUCT_IMAGE_TOO_LARGE | PRODUCT_IMAGE_KEY_MISMATCH | PRODUCT_IMAGE_PRIMARY_REQUIRED',
          },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');

      const body = request.body as {
        images: {
          primary?: { s3Key: string; altText?: string | null };
          others?: Array<{ s3Key: string; altText?: string | null }>;
        };
      };

      const result = await service.confirmImages(
        params.data.id,
        {
          ...(body.images.primary
            ? { primary: { s3Key: body.images.primary.s3Key, altText: body.images.primary.altText ?? null } }
            : {}),
          others: (body.images.others ?? []).map((o) => ({
            s3Key: o.s3Key,
            altText: o.altText ?? null,
          })),
        },
        request.user,
        request.id,
      );
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /products/:id/images/primary
  // ---------------------------------------------------------------------------
  app.patch(
    '/products/:id/images/primary',
    {
      schema: {
        tags: ['Products'],
        summary: 'Set the primary image for a product',
        description:
          'Promotes an already-confirmed image to primary and demotes all others. ' +
          'The s3Key must exist in the product media list — use the s3Key values ' +
          'returned in ProductView.media. No S3 call is made. ' +
          'Calling this with the current primary s3Key is a no-op (returns 200 unchanged).',
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
          required: ['s3Key'],
          properties: {
            s3Key: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
          422: {
            ...errorSchema,
            description: 'PRODUCT_IMAGE_NOT_FOUND — s3Key not in product media',
          },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');
      const body = request.body as { s3Key: string };
      const result = await service.setPrimaryImage(params.data.id, body.s3Key, request.user, request.id);
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // PUT /products/:id/images/reorder
  // ---------------------------------------------------------------------------
  app.put(
    '/products/:id/images/reorder',
    {
      schema: {
        tags: ['Products'],
        summary: 'Reorder product images',
        description:
          'Sets the display order of all existing product images. ' +
          's3Keys must include every existing image s3Key — partial lists are rejected. ' +
          'Array position maps directly to sortOrder (index 0 = first). ' +
          'isPrimary is preserved — reorder does not change which image is primary.',
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
          required: ['s3Keys'],
          properties: {
            s3Keys: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
        response: {
          200: productSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Product not found' },
          422: {
            ...errorSchema,
            description: 'PRODUCT_IMAGE_REORDER_MISMATCH — list length or keys do not match existing media',
          },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('product:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = ProductParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid product id');

      const body = request.body as { s3Keys: string[] };
      const result = await service.reorderImages(params.data.id, body.s3Keys, request.user, request.id);
      return reply.status(200).send(result);
    },
  );
};
