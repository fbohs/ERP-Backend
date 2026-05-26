import type { FastifyPluginAsync } from 'fastify';
import {
  LoginBodySchema,
  ForgotPasswordBodySchema,
  ResetPasswordBodySchema,
  SetupPasswordBodySchema,
  type LoginResponse,
} from './auth.schemas.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { createAuthenticate } from '../../shared/auth/authenticate.js';
import { AuditRepository } from '../../shared/audit/index.js';
import { createIdempotency } from '../../shared/idempotency/index.js';
import { ValidationError } from '../../shared/errors/base.js';
import { createPasswordResetEmailQueue } from './jobs/send-password-reset-email.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

interface AuthPluginOptions {
  db: AppDb;
  redis: Redis;
  // Durable (AOF-persisted) Redis — backs the Idempotency-Key store.
  queueRedis: Redis;
  // Queue Redis URL for the password-reset email queue, or null when email
  // is disabled (no RESEND_API_KEY) — in which case no queue is created.
  emailQueueUrl: string | null;
  appBaseUrl: string;
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const repo = new AuthRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const emailQueue =
    opts.emailQueueUrl !== null ? createPasswordResetEmailQueue(opts.emailQueueUrl) : null;
  const service = new AuthService(repo, auditRepo, opts.redis, opts.db, emailQueue, opts.appBaseUrl);
  const authenticate = createAuthenticate(opts.db, opts.redis);
  const idempotency = createIdempotency(opts.queueRedis);

  app.post<{ Reply: LoginResponse }>(
    '/auth/login',
    { preHandler: [idempotency.before], onSend: [idempotency.after] },
    async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }

      const result = await service.login(parsed.data.email, parsed.data.password, request.id);
      return reply.status(200).send(result);
    },
  );

  app.delete(
    '/auth/logout',
    { preHandler: [idempotency.before, authenticate], onSend: [idempotency.after] },
    async (request, reply) => {
      const token = request.headers.authorization!.replace('Bearer ', '');
      await service.logout(token, request.user, request.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/forgot-password',
    { preHandler: [idempotency.before], onSend: [idempotency.after] },
    async (request, reply) => {
      const parsed = ForgotPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }

      await service.forgotPassword(parsed.data.email, request.id);
      return reply.status(200).send();
    },
  );

  app.post(
    '/auth/reset-password',
    { preHandler: [idempotency.before], onSend: [idempotency.after] },
    async (request, reply) => {
      const parsed = ResetPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }

      await service.resetPassword(parsed.data.token, parsed.data.newPassword, request.id);
      return reply.status(200).send();
    },
  );

  app.post(
    '/auth/setup-password',
    { preHandler: [idempotency.before], onSend: [idempotency.after] },
    async (request, reply) => {
      const parsed = SetupPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }

      const result = await service.setupPassword(
        parsed.data.token,
        parsed.data.newPassword,
        request.id,
      );
      return reply.status(200).send(result);
    },
  );
};
