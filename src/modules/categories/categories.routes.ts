import type { FastifyPluginAsync } from 'fastify';
import { CategoriesRepository } from './categories.repository.js';
import { CategoriesService } from './categories.service.js';
import { AuditRepository } from '@/shared/audit/index.js';
import { createAuthenticate, authorize } from '@/shared/auth/index.js';
import { createIdempotency } from '@/shared/idempotency/index.js';
import { ValidationError } from '@/shared/errors/base.js';
import {
  CreateCategoryBodySchema,
  UpdateCategoryBodySchema,
  CategoryParamsSchema,
} from './categories.schemas.js';
import type { AppDb } from '@/shared/db/index.js';
import type { Redis } from '@/shared/cache/redis.js';

interface CategoriesPluginOptions {
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

const categorySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: ['string', 'null'] },
    parentId: { type: ['string', 'null'], format: 'uuid' },
    // isActive is only present for ADMIN callers — omitted from non-admin responses.
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const categoriesPlugin: FastifyPluginAsync<CategoriesPluginOptions> = async (app, opts) => {
  const repo = new CategoriesRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const service = new CategoriesService(repo, auditRepo, opts.db);
  const authenticate = createAuthenticate(opts.db, opts.redis);
  const idempotency = createIdempotency(opts.queueRedis);

  // ---------------------------------------------------------------------------
  // POST /categories
  // ---------------------------------------------------------------------------
  app.post(
    '/categories',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Create a category',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            slug: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: ['string', 'null'], maxLength: 1000 },
            parentId: { type: ['string', 'null'], format: 'uuid' },
          },
        },
        response: {
          201: categorySchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          409: { ...errorSchema, description: 'Slug already in use (CATEGORY_SLUG_EXISTS)' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('category:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const parsed = CreateCategoryBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid request body');
      const result = await service.create(
        parsed.data,
        { userId: request.user.userId, tenantId: request.user.tenantId },
        request.id,
      );
      return reply.status(201).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /categories
  // ---------------------------------------------------------------------------
  app.get(
    '/categories',
    {
      schema: {
        tags: ['Categories'],
        summary: 'List categories',
        description: 'ADMIN sees all categories. Other roles see active categories only.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: { categories: { type: 'array', items: categorySchema } },
          },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
        },
      },
      preHandler: [authenticate, authorize('product:read')],
    },
    async (request, reply) => {
      const isAdmin = request.user.role === 'ADMIN';
      const categories = await service.list(request.user.tenantId, isAdmin);
      return reply.status(200).send({ categories });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /categories/:id
  // ---------------------------------------------------------------------------
  app.get(
    '/categories/:id',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Get a single category',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: categorySchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Category not found' },
          422: { ...errorSchema, description: 'Invalid id format' },
        },
      },
      preHandler: [authenticate, authorize('product:read')],
    },
    async (request, reply) => {
      const params = CategoryParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid category id');
      const isAdmin = request.user.role === 'ADMIN';
      const category = await service.get(params.data.id, request.user.tenantId, isAdmin);
      return reply.status(200).send(category);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /categories/:id/children
  // ---------------------------------------------------------------------------
  app.get(
    '/categories/:id/children',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Get full subtree of a category (flat list)',
        description:
          'Returns all descendants of the given category as a flat list ordered by name. ' +
          'Non-admin users: inactive nodes are excluded and their subtrees are not traversed.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: { categories: { type: 'array', items: categorySchema } },
          },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Category not found' },
          422: { ...errorSchema, description: 'Invalid id format' },
        },
      },
      preHandler: [authenticate, authorize('product:read')],
    },
    async (request, reply) => {
      const params = CategoryParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid category id');
      const isAdmin = request.user.role === 'ADMIN';
      const categories = await service.getChildren(params.data.id, request.user.tenantId, isAdmin);
      return reply.status(200).send({ categories });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /categories/:id
  // ---------------------------------------------------------------------------
  app.patch(
    '/categories/:id',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Update a category',
        description: 'Supports reparenting via parentId. Set parentId to null to make it a root category.',
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
            slug: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: ['string', 'null'], maxLength: 1000 },
            parentId: { type: ['string', 'null'], format: 'uuid' },
            isActive: { type: 'boolean' },
          },
        },
        response: {
          200: categorySchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Category not found' },
          409: {
            ...errorSchema,
            description:
              'CATEGORY_SLUG_EXISTS — slug taken; CIRCULAR_CATEGORY_REFERENCE — reparent would create a cycle',
          },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('category:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = CategoryParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid category id');
      const parsed = UpdateCategoryBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid request body');
      const result = await service.update(
        params.data.id,
        parsed.data,
        { userId: request.user.userId, tenantId: request.user.tenantId },
        request.id,
      );
      return reply.status(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /categories/:id
  // ---------------------------------------------------------------------------
  app.delete(
    '/categories/:id',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Deactivate a category (soft)',
        description:
          'Sets isActive = false. Blocked if any DRAFT or READY product references this category.',
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
          204: { type: 'null', description: 'Category deactivated' },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'Category not found' },
          409: { ...errorSchema, description: 'CATEGORY_HAS_PRODUCTS' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('category:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = CategoryParamsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('Invalid category id');
      await service.deactivate(
        params.data.id,
        { userId: request.user.userId, tenantId: request.user.tenantId },
        request.id,
      );
      return reply.status(204).send();
    },
  );
};
