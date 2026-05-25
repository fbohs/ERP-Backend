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
import { AuditRepository, PlatformAuditRepository } from '../../shared/audit/index.js';
import { createAuthenticatePlatform, createIpAllowlist } from '../../shared/auth/index.js';
import { createIdempotency } from '../../shared/idempotency/index.js';
import { ValidationError, NotFoundError } from '../../shared/errors/base.js';
import { createPasswordResetEmailQueue } from '../auth/index.js';
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

export const platformPlugin: FastifyPluginAsync<PlatformPluginOptions> = async (app, opts) => {
  const repo = new PlatformRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const platformAuditRepo = new PlatformAuditRepository(opts.db);
  const loginEmailQueue =
    opts.emailQueueUrl !== null ? createPlatformLoginEmailQueue(opts.emailQueueUrl) : null;
  const onboardingEmailQueue =
    opts.emailQueueUrl !== null ? createPasswordResetEmailQueue(opts.emailQueueUrl) : null;
  const service = new PlatformService(
    repo,
    auditRepo,
    platformAuditRepo,
    opts.db,
    loginEmailQueue,
    onboardingEmailQueue,
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
    { preHandler: [idempotency.before], onSend: [idempotency.after] },
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
    { preHandler: [idempotency.before], onSend: [idempotency.after] },
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
    { preHandler: [idempotency.before, authenticatePlatform], onSend: [idempotency.after] },
    async (request, reply) => {
      const token = request.headers.authorization!.slice(7);
      await service.logout(token, { adminId: request.platformAdmin.adminId }, request.ip, request.id);
      return reply.status(204).send();
    },
  );

  app.get('/platform/tenants', { preHandler: [authenticatePlatform] }, async (_request, reply) => {
    const tenants = await service.listTenants();
    return reply.status(200).send({ tenants });
  });

  app.post(
    '/platform/tenants',
    { preHandler: [idempotency.before, authenticatePlatform], onSend: [idempotency.after] },
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
    { preHandler: [idempotency.before, authenticatePlatform], onSend: [idempotency.after] },
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
