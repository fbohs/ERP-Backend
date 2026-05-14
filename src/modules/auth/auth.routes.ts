import type { FastifyPluginAsync } from 'fastify';
import { LoginBodySchema, type LoginResponse } from './auth.schemas.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { createAuthenticate } from '../../shared/auth/authenticate.js';
import { ValidationError } from '../../shared/errors/base.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

interface AuthPluginOptions {
  db: AppDb;
  redis: Redis;
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const repo = new AuthRepository(opts.db);
  const service = new AuthService(repo, opts.redis);
  const authenticate = createAuthenticate(opts.db, opts.redis);

  app.post<{ Reply: LoginResponse }>(
    '/auth/login',
    async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body');
      }

      const result = await service.login(parsed.data.email, parsed.data.password);
      return reply.status(200).send(result);
    },
  );

  app.delete(
    '/auth/logout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const token = request.headers.authorization!.replace('Bearer ', '');
      await service.logout(token);
      return reply.status(204).send();
    },
  );
};
