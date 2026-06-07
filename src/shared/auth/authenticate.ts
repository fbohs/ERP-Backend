import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '@/shared/errors/base.js';
import { sessionCacheKey, type CachedSession } from './session.js';
import { hashToken } from './token-hash.js';
import type { AppDb } from '@/shared/db/index.js';
import type { Redis } from '@/shared/cache/redis.js';

export function createAuthenticate(db: AppDb, redis: Redis) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const tokenHash = hashToken(token);

    // Fast path: Redis cache hit
    const cached = await redis.get(sessionCacheKey(tokenHash));
    if (cached !== null) {
      request.user = JSON.parse(cached) as CachedSession;
      return;
    }

    // Slow path: DB lookup
    const row = await db
      .selectFrom('Session')
      .innerJoin('User', 'User.id', 'Session.userId')
      .innerJoin('Tenant', 'Tenant.id', 'User.tenantId')
      .select([
        'User.id as userId',
        'User.tenantId',
        'User.role',
        'User.isActive',
        'Tenant.isActive as tenantIsActive',
        'Session.expiresAt',
      ])
      .where('Session.token', '=', tokenHash)
      .executeTakeFirst();

    if (!row || !row.isActive || !row.tenantIsActive) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt as string);
    if (expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const session: CachedSession = { userId: row.userId, tenantId: row.tenantId, role: row.role };

    const remainingTtl = Math.floor((expiresAt.getTime() - Date.now()) / 1_000);
    if (remainingTtl > 0) {
      await redis.setex(sessionCacheKey(tokenHash), remainingTtl, JSON.stringify(session));
    }

    request.user = session;
  };
}
