import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../errors/base.js';
import { hashToken } from './token-hash.js';
import type { PlatformPrincipal } from './platform-session.js';
import type { AppDb } from '../db/index.js';

export function createAuthenticatePlatform(db: AppDb) {
  return async function authenticatePlatform(request: FastifyRequest): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);

    // DB-only by design: the platform surface has NO session cache, so deleting
    // a session row revokes access on the very next request — that is what makes
    // logout, single-session eviction, and CLI termination effective. The tiny
    // operator population makes the cache's throughput benefit irrelevant. Only
    // the token hash is stored, so we match on the hash of the presented token.
    // See ADR 0002.
    const row = await db
      .selectFrom('PlatformAdminSession')
      .innerJoin('PlatformAdmin', 'PlatformAdmin.id', 'PlatformAdminSession.adminId')
      .select([
        'PlatformAdmin.id as adminId',
        'PlatformAdmin.isActive',
        'PlatformAdminSession.expiresAt',
      ])
      .where('PlatformAdminSession.tokenHash', '=', hashToken(token))
      .executeTakeFirst();

    if (!row || !row.isActive) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt as string);
    if (expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const principal: PlatformPrincipal = { adminId: row.adminId };
    request.platformAdmin = principal;
  };
}
