import type { FastifyPluginAsync } from 'fastify';
import {
  CreateUserBodySchema,
  SetUserActiveBodySchema,
  UserParamsSchema,
} from './users.schemas.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import { createUserWelcomeEmailQueue } from './jobs/send-user-welcome-email.js';
import { AuditRepository } from '../../shared/audit/index.js';
import { createAuthenticate, authorize } from '../../shared/auth/index.js';
import { createIdempotency } from '../../shared/idempotency/index.js';
import { ValidationError } from '../../shared/errors/base.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

interface UsersPluginOptions {
  db: AppDb;
  redis: Redis;
  queueRedis: Redis;
  emailQueueUrl: string | null;
  appBaseUrl: string;
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

const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    role: { type: 'string' },
    isActive: { type: 'boolean' },
    specs: {},
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const usersPlugin: FastifyPluginAsync<UsersPluginOptions> = async (app, opts) => {
  const repo = new UsersRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const welcomeEmailQueue =
    opts.emailQueueUrl !== null ? createUserWelcomeEmailQueue(opts.emailQueueUrl) : null;
  const service = new UsersService(repo, auditRepo, opts.db, welcomeEmailQueue, opts.appBaseUrl);
  const authenticate = createAuthenticate(opts.db, opts.redis);
  const idempotency = createIdempotency(opts.queueRedis);

  app.post(
    '/users',
    {
      schema: {
        tags: ['Users'],
        summary: 'Create a user',
        description:
          'Tenant admin creates a subordinate user. A temporary password is generated and emailed to the new user, who must change it on first login.',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['email', 'name', 'role', 'specs'],
          properties: {
            email: { type: 'string', format: 'email' },
            name: { type: 'string', minLength: 1 },
            role: { type: 'string', enum: [
              'INVENTORY_MANAGER', 'PURCHASING_MANAGER', 'SALES_MANAGER',
              'WAREHOUSE_OPERATOR', 'MERCHANT', 'PRODUCT_VERIFIER',
              'CONTENT_MANAGER', 'REPORT_VIEWER',
            ]},
            specs: { description: 'Role-specific metadata. Required for MERCHANT and PRODUCT_VERIFIER; null for other roles.' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string', format: 'email' },
              role: { type: 'string' },
            },
          },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions or forbidden role' },
          409: { ...errorSchema, description: 'Email already taken (EMAIL_ALREADY_TAKEN)' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('user:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const parsed = CreateUserBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }
      const result = await service.createUser(
        parsed.data,
        { userId: request.user.userId, tenantId: request.user.tenantId },
        request.id,
      );
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/users',
    {
      schema: {
        tags: ['Users'],
        summary: 'List users in tenant',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              users: { type: 'array', items: userSchema },
            },
          },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
        },
      },
      preHandler: [authenticate, authorize('user:read')],
    },
    async (request, reply) => {
      const users = await service.listUsers({
        userId: request.user.userId,
        tenantId: request.user.tenantId,
      });
      return reply.status(200).send({ users });
    },
  );

  app.get(
    '/users/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Get a single user',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: userSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions' },
          404: { ...errorSchema, description: 'User not found' },
        },
      },
      preHandler: [authenticate, authorize('user:read')],
    },
    async (request, reply) => {
      const params = UserParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('Invalid user id');
      }
      const user = await service.getUser(params.data.id, {
        userId: request.user.userId,
        tenantId: request.user.tenantId,
      });
      return reply.status(200).send(user);
    },
  );

  app.patch(
    '/users/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Suspend or reactivate a user',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string' },
          },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['isActive'],
          properties: {
            isActive: { type: 'boolean' },
          },
        },
        response: {
          200: userSchema,
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions or cannot modify self' },
          404: { ...errorSchema, description: 'User not found' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('user:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = UserParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('Invalid user id');
      }
      const parsed = SetUserActiveBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }
      const user = await service.setUserActive(
        params.data.id,
        parsed.data.isActive,
        { userId: request.user.userId, tenantId: request.user.tenantId },
        request.id,
      );
      return reply.status(200).send(user);
    },
  );

  app.delete(
    '/users/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Delete a user (soft)',
        description: 'Deactivates the user permanently. The record is retained for audit purposes.',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string' },
          },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          204: { type: 'null', description: 'User deactivated' },
          401: { ...errorSchema, description: 'Missing or invalid session' },
          403: { ...errorSchema, description: 'Insufficient permissions or cannot delete self' },
          404: { ...errorSchema, description: 'User not found' },
        },
      },
      preHandler: [idempotency.before, authenticate, authorize('user:write')],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = UserParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('Invalid user id');
      }
      await service.deleteUser(
        params.data.id,
        { userId: request.user.userId, tenantId: request.user.tenantId },
        request.id,
      );
      return reply.status(204).send();
    },
  );
};
