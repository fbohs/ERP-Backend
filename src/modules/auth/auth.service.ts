import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { config } from '../../shared/config/index.js';
import { UnauthorizedError } from '../../shared/errors/base.js';
import { sessionCacheKey, type CachedSession } from '../../shared/auth/session.js';
import type { AuthRepository } from './auth.repository.js';
import type { Redis } from '../../shared/cache/redis.js';

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly redis: Redis,
  ) {}

  async login(email: string, password: string) {
    const user = await this.repo.findUserByEmail(email);

    if (!user || !user.isActive || !user.tenantIsActive) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const valid = await argon2.verify(user.password, password);
    if (!valid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1_000);

    await this.repo.createSession(user.id, token, expiresAt);

    const cached: CachedSession = { userId: user.id, tenantId: user.tenantId, role: user.role };
    await this.redis.setex(sessionCacheKey(token), config.sessionTtlSeconds, JSON.stringify(cached));

    return {
      token,
      user: { id: user.publicId, name: user.name, role: user.role },
      tenant: { id: user.tenantPublicId, slug: user.tenantSlug, name: user.tenantName },
    };
  }

  async logout(token: string): Promise<void> {
    await Promise.all([
      this.repo.deleteSession(token),
      this.redis.del(sessionCacheKey(token)),
    ]);
  }
}
