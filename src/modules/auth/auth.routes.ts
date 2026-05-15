import type { FastifyPluginAsync } from 'fastify';
import {
  LoginBodySchema,
  ForgotPasswordBodySchema,
  ResetPasswordBodySchema,
  type LoginResponse,
} from './auth.schemas.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { createAuthenticate } from '../../shared/auth/authenticate.js';
import { AuditRepository } from '../../shared/audit/index.js';
import { ValidationError } from '../../shared/errors/base.js';
import { createPasswordResetEmailQueue } from './jobs/send-password-reset-email.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

interface AuthPluginOptions {
  db: AppDb;
  redis: Redis;
  redisUrl?: string;
  appBaseUrl: string;
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const repo = new AuthRepository(opts.db);
  const auditRepo = new AuditRepository(opts.db);
  const emailQueue = opts.redisUrl ? createPasswordResetEmailQueue(opts.redisUrl) : null;
  const service = new AuthService(repo, auditRepo, opts.redis, opts.db, emailQueue, opts.appBaseUrl);
  const authenticate = createAuthenticate(opts.db, opts.redis);

  app.post<{ Reply: LoginResponse }>(
    '/auth/login',
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
    { preHandler: [authenticate] },
    async (request, reply) => {
      const token = request.headers.authorization!.replace('Bearer ', '');
      await service.logout(token, request.user, request.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/forgot-password',
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
    async (request, reply) => {
      const parsed = ResetPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }

      await service.resetPassword(parsed.data.token, parsed.data.newPassword, request.id);
      return reply.status(200).send();
    },
  );
};
