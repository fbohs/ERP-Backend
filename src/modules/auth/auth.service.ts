import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { config } from '../../shared/config/index.js';
import { UnauthorizedError } from '../../shared/errors/base.js';
import { sessionCacheKey, type CachedSession } from '../../shared/auth/session.js';
import {
  enqueuePasswordResetEmail,
  type PasswordResetEmailQueue,
} from './jobs/send-password-reset-email.js';
import type { AuthRepository } from './auth.repository.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly redis: Redis,
    private readonly db: AppDb,
    private readonly emailQueue: PasswordResetEmailQueue | null,
    private readonly appBaseUrl: string,
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

  async forgotPassword(email: string): Promise<void> {
    const user = await this.repo.findUserByEmail(email);

    // Return silently regardless — never reveal whether the email exists
    if (!user || !user.isActive || !user.tenantIsActive) {
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.passwordResetTtlSeconds * 1_000);

    await this.repo.createPasswordResetToken(user.id, token, expiresAt);

    if (this.emailQueue) {
      const resetUrl = `${this.appBaseUrl}/reset-password?token=${token}`;
      await enqueuePasswordResetEmail(this.emailQueue, token, {
        email: user.email,
        name: user.name,
        resetUrl,
      });
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await this.repo.findPasswordResetToken(token);

    if (!record) {
      throw new UnauthorizedError('Invalid or expired reset token');
    }

    const expiresAt =
      record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt as string);

    if (expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('Invalid or expired reset token');
    }

    if (record.usedAt !== null) {
      throw new UnauthorizedError('Invalid or expired reset token');
    }

    const passwordHash = await argon2.hash(newPassword);

    let sessionTokens: string[] = [];

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      sessionTokens = await txRepo.getUserSessionTokens(record.userId);
      await txRepo.updateUserPassword(record.userId, passwordHash);
      await txRepo.markTokenUsed(token);
      await txRepo.deleteUserSessions(record.userId);
    });

    if (sessionTokens.length > 0) {
      await Promise.all(sessionTokens.map((t) => this.redis.del(sessionCacheKey(t))));
    }
  }
}
