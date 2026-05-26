import type { FastifyPluginAsync } from 'fastify';
import {
  RequestLinkBodySchema,
  VerifyBodySchema,
  CreateTenantBodySchema,
  UpdateTenantBodySchema,
  TenantParamsSchema,
  type VerifyResponse,
} from './platform.schemas.js';
import { PlatformRepository } from './platform.repository.js';
import { PlatformService } from './platform.service.js';
import { createPlatformLoginEmailQueue } from './jobs/send-login-link-email.js';
import { createTenantWelcomeEmailQueue } from './jobs/send-tenant-welcome-email.js';
import { AuditRepository, PlatformAuditRepository } from '../../shared/audit/index.js';
import { createAuthenticatePlatform, createIpAllowlist } from '../../shared/auth/index.js';
import { createIdempotency } from '../../shared/idempotency/index.js';
import { ValidationError, NotFoundError } from '../../shared/errors/base.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

interface PlatformPluginOptions {
  db: AppDb;
  // Durable (AOF-persisted) Redis — backs the Idempotency-Key store. The
  // platform surface does NOT use the session cache: its auth is DB-only so a
  // deleted session row revokes access immediately. See ADR 0002.
  queueRedis: Redis;
  // Queue Redis URL for the login-link / onboarding email queues, or null when
  // email is disabled (no RESEND_API_KEY).
  emailQueueUrl: string | null;
  appBaseUrl: string;
  // Comma-separated exact IPs and IPv4 CIDR ranges allowed to reach this
  // surface. Empty = fail-closed (deny all).
  ipAllowlist: string;
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

const tenantSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    isActive: { type: 'boolean' },
    plan: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const platformPlugin: FastifyPluginAsync<PlatformPluginOptions> = async (app, opts) => {
  const repo = new PlatformRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const platformAuditRepo = new PlatformAuditRepository(opts.db);
  const loginEmailQueue =
    opts.emailQueueUrl !== null ? createPlatformLoginEmailQueue(opts.emailQueueUrl) : null;
  const welcomeEmailQueue =
    opts.emailQueueUrl !== null ? createTenantWelcomeEmailQueue(opts.emailQueueUrl) : null;
  const service = new PlatformService(
    repo,
    auditRepo,
    platformAuditRepo,
    opts.db,
    loginEmailQueue,
    welcomeEmailQueue,
    opts.appBaseUrl,
  );
  const authenticatePlatform = createAuthenticatePlatform(opts.db);
  const idempotency = createIdempotency(opts.queueRedis);
  const allowlist = createIpAllowlist(opts.ipAllowlist);

  // First line of defense for the whole surface: drop non-allowlisted IPs
  // before anything else runs. Respond 404 (not 403) so the surface's
  // existence is not disclosed to scanners. See ADR 0002.
  app.addHook('onRequest', async (request) => {
    if (!allowlist.allows(request.ip)) {
      throw new NotFoundError('Not found');
    }
  });

  app.post(
    '/platform/auth/request-link',
    {
      schema: {
        tags: ['Platform Auth'],
        summary: 'Request a magic-link login email',
        description:
          'Sends a one-time sign-in link to the given email if it belongs to an active platform admin. Always returns 200 to prevent admin email enumeration.',
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', description: 'Deduplicates concurrent or retried requests' },
          },
        },
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', description: 'Email address of the platform admin' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
          },
        },
      },
      preHandler: [idempotency.before],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const parsed = RequestLinkBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }
      await service.requestLoginLink(parsed.data.email, request.ip);
      return reply.status(200).send({
        message: "If that email belongs to an admin, a sign-in link is on its way.",
      });
    },
  );

  app.post<{ Reply: VerifyResponse }>(
    '/platform/auth/verify',
    {
      schema: {
        tags: ['Platform Auth'],
        summary: 'Exchange a magic-link token for a session token',
        description:
          'Consumes the one-time token from the login-link email and returns a session token. The link token is deleted on use — concurrent calls with the same token will have exactly one succeed.',
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', description: 'Deduplicates concurrent or retried requests' },
          },
        },
        body: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string', minLength: 1, description: 'Raw token from the login-link email' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['token'],
            properties: {
              token: { type: 'string', description: 'Session token — pass as Bearer in subsequent requests' },
            },
          },
          401: { ...errorSchema, description: 'Token invalid, expired, already used, or admin inactive' },
        },
      },
      preHandler: [idempotency.before],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const parsed = VerifyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }
      const result = await service.verifyLoginLink(parsed.data.token, request.ip);
      return reply.status(200).send(result);
    },
  );

  app.delete(
    '/platform/auth/logout',
    {
      schema: {
        tags: ['Platform Auth'],
        summary: 'Invalidate the current session',
        description: 'Deletes the session row immediately — the token is revoked on the next request.',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          required: ['authorization'],
          properties: {
            authorization: { type: 'string', description: 'Bearer <session token>' },
            'idempotency-key': { type: 'string', description: 'Deduplicates concurrent or retried requests' },
          },
        },
        response: {
          204: { type: 'null', description: 'Session cleared' },
          401: { ...errorSchema, description: 'Missing, invalid, or expired session token' },
        },
      },
      preHandler: [idempotency.before, authenticatePlatform],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const token = request.headers.authorization!.slice(7);
      await service.logout(token, { adminId: request.platformAdmin.adminId }, request.ip, request.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/platform/tenants',
    {
      schema: {
        tags: ['Platform Tenants'],
        summary: 'List all tenants',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              tenants: { type: 'array', items: tenantSchema },
            },
          },
          401: { ...errorSchema, description: 'Missing or invalid session token' },
        },
      },
      preHandler: [authenticatePlatform],
    },
    async (_request, reply) => {
      const tenants = await service.listTenants();
      return reply.status(200).send({ tenants });
    },
  );

  app.get(
    '/platform/tenants/:id',
    {
      schema: {
        tags: ['Platform Tenants'],
        summary: 'Get a single tenant',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Tenant public ID' },
          },
        },
        response: {
          200: tenantSchema,
          401: { ...errorSchema, description: 'Missing or invalid session token' },
          404: { ...errorSchema, description: 'Tenant not found' },
        },
      },
      preHandler: [authenticatePlatform],
    },
    async (request, reply) => {
      const params = TenantParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('Invalid tenant id');
      }
      const result = await service.getTenant(params.data.id);
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/platform/tenants',
    {
      schema: {
        tags: ['Platform Tenants'],
        summary: 'Create a tenant and provision its first admin',
        description:
          'Creates the tenant, its first ADMIN user (with an unguessable placeholder password), and enqueues a set-password email to the admin. The tenant is active immediately.',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', description: 'Deduplicates concurrent or retried requests' },
          },
        },
        body: {
          type: 'object',
          required: ['tenant', 'admin'],
          properties: {
            tenant: {
              type: 'object',
              required: ['name', 'slug'],
              properties: {
                name: { type: 'string', minLength: 1, description: 'Display name of the tenant' },
                slug: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 63,
                  pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
                  description: 'URL-safe lowercase slug, unique across all tenants',
                },
              },
            },
            admin: {
              type: 'object',
              required: ['email', 'name'],
              properties: {
                email: { type: 'string', format: 'email', description: 'Email for the first admin user' },
                name: { type: 'string', minLength: 1, description: 'Full name of the first admin user' },
              },
            },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              tenant: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  slug: { type: 'string' },
                  name: { type: 'string' },
                },
              },
              admin: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          },
          401: { ...errorSchema, description: 'Missing or invalid session token' },
          409: { ...errorSchema, description: 'Slug already taken (TENANT_SLUG_TAKEN)' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticatePlatform],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const parsed = CreateTenantBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }
      const result = await service.createTenant(
        parsed.data,
        { adminId: request.platformAdmin.adminId },
        request.id,
      );
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/platform/tenants/:id',
    {
      schema: {
        tags: ['Platform Tenants'],
        summary: 'Suspend or reactivate a tenant',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', description: 'Deduplicates concurrent or retried requests' },
          },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Tenant public ID' },
          },
        },
        body: {
          type: 'object',
          required: ['isActive'],
          properties: {
            isActive: { type: 'boolean', description: 'true to reactivate, false to suspend' },
          },
        },
        response: {
          200: tenantSchema,
          401: { ...errorSchema, description: 'Missing or invalid session token' },
          404: { ...errorSchema, description: 'Tenant not found' },
          422: { ...errorSchema, description: 'Validation error' },
        },
      },
      preHandler: [idempotency.before, authenticatePlatform],
      onSend: [idempotency.after],
    },
    async (request, reply) => {
      const params = TenantParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('Invalid tenant id');
      }
      const parsed = UpdateTenantBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }
      const result = await service.setTenantActive(
        params.data.id,
        parsed.data.isActive,
        { adminId: request.platformAdmin.adminId },
        request.id,
      );
      return reply.status(200).send(result);
    },
  );
};
