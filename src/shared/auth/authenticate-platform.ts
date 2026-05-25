import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../errors/base.js';
import { platformSessionCacheKey, type CachedPlatformSession } from './platform-session.js';
import type { AppDb } from '../db/index.js';
import type { Redis } from '../cache/redis.js';

export function createAuthenticatePlatform(db: AppDb, redis: Redis) {
  return async function authenticatePlatform(request: FastifyRequest): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);

    // Fast path: Redis cache hit
    const cached = await redis.get(platformSessionCacheKey(token));
    if (cached !== null) {
      request.platformAdmin = JSON.parse(cached) as CachedPlatformSession;
      return;
    }

    // Slow path: DB lookup
    const row = await db
      .selectFrom('PlatformAdminSession')
      .innerJoin('PlatformAdmin', 'PlatformAdmin.id', 'PlatformAdminSession.adminId')
      .select([
        'PlatformAdmin.id as adminId',
        'PlatformAdmin.isActive',
        'PlatformAdminSession.expiresAt',
      ])
      .where('PlatformAdminSession.token', '=', token)
      .executeTakeFirst();

    if (!row || !row.isActive) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt as string);
    if (expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const session: CachedPlatformSession = { adminId: row.adminId };

    const remainingTtl = Math.floor((expiresAt.getTime() - Date.now()) / 1_000);
    if (remainingTtl > 0) {
      await redis.setex(platformSessionCacheKey(token), remainingTtl, JSON.stringify(session));
    }

    request.platformAdmin = session;
  };
}
