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
import type { AuditRepository } from '../../shared/audit/index.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

const AUDIT_ACTION = {
  login: 'auth.login',
  logout: 'auth.logout',
  passwordResetRequested: 'auth.password_reset_requested',
  passwordResetCompleted: 'auth.password_reset_completed',
  firstLoginSetupCompleted: 'auth.first_login_setup_completed',
} as const;

// Precomputed argon2id hash of a random string. Verifying a submitted password
// against this when no user is found makes login spend the same CPU whether or
// not the email exists — closing the timing side channel that would otherwise
// enumerate accounts. See learnings/technical/auth-timing-attacks.md.
const DECOY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$2WDaBB7J5t5ksnwhjppy5w$L0OFJvyc3SC1oGerlju26ekiICO5D+VmbLcsizaFMsY';

export interface SessionActor {
  userId: string;
  tenantId: string;
}

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly audit: AuditRepository,
    private readonly redis: Redis,
    private readonly db: AppDb,
    private readonly emailQueue: PasswordResetEmailQueue | null,
    private readonly appBaseUrl: string,
  ) {}

  async login(email: string, password: string, requestId: string) {
    const user = await this.repo.findUserByEmail(email);

    // Verify unconditionally — against the decoy hash when the email has no
    // account — so the work done is identical whether or not the user exists.
    const passwordMatches = await argon2.verify(
      user?.password ?? DECOY_PASSWORD_HASH,
      password,
    );

    if (!user || !user.isActive || !user.tenantIsActive || !passwordMatches) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // First-login forced password change: mint a short-lived setup token and
    // return it instead of a session. No real access is granted until the user
    // picks their own password via POST /auth/setup-password.
    if (user.mustChangePassword) {
      const setupToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + config.firstLoginSetupTtlSeconds * 1_000);

      await this.db.transaction().execute(async (tx) => {
        const txRepo = this.repo.withTx(tx);
        await txRepo.deleteUnusedPasswordResetTokens(user.id);
        await txRepo.createPasswordResetToken(user.id, setupToken, expiresAt, 'FIRST_LOGIN_SETUP');
      });

      return { requiresPasswordChange: true as const, setupToken };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1_000);

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).createSession(user.id, token, expiresAt);
      await this.audit.withTx(tx).record({
        tenantId: user.tenantId,
        actorId: user.id,
        entityType: 'User',
        entityId: user.id,
        action: AUDIT_ACTION.login,
        requestId,
      });
    });

    const cached: CachedSession = { userId: user.id, tenantId: user.tenantId, role: user.role };
    await this.redis.setex(sessionCacheKey(token), config.sessionTtlSeconds, JSON.stringify(cached));

    return {
      requiresPasswordChange: false as const,
      token,
      user: { id: user.publicId, name: user.name, role: user.role },
      tenant: { id: user.tenantPublicId, slug: user.tenantSlug, name: user.tenantName },
    };
  }

  async logout(token: string, actor: SessionActor, requestId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).deleteSession(token);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'User',
        entityId: actor.userId,
        action: AUDIT_ACTION.logout,
        requestId,
      });
    });

    await this.redis.del(sessionCacheKey(token));
  }

  async forgotPassword(email: string, requestId: string): Promise<void> {
    const user = await this.repo.findUserByEmail(email);
    // Never reveal whether the email exists — not via the response (always
    // 200) and not via timing. The token and a transaction are produced
    // unconditionally so an unknown email costs the same as a known one.
    const account =
      user !== undefined && user.isActive && user.tenantIsActive ? user : null;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.passwordResetTtlSeconds * 1_000);

    await this.db.transaction().execute(async (tx) => {
      if (account === null) {
        return;
      }
      const txRepo = this.repo.withTx(tx);
      // Supersede any earlier unused tokens — only the newest link stays live.
      await txRepo.deleteUnusedPasswordResetTokens(account.id);
      await txRepo.createPasswordResetToken(account.id, token, expiresAt, 'PASSWORD_RESET');
      await this.audit.withTx(tx).record({
        tenantId: account.tenantId,
        actorId: account.id,
        entityType: 'User',
        entityId: account.id,
        action: AUDIT_ACTION.passwordResetRequested,
        requestId,
      });
    });

    if (account !== null && this.emailQueue) {
      const resetUrl = `${this.appBaseUrl}/reset-password?token=${token}`;
      await enqueuePasswordResetEmail(this.emailQueue, token, {
        email: account.email,
        name: account.name,
        resetUrl,
      });
    }
  }

  async resetPassword(token: string, newPassword: string, requestId: string): Promise<void> {
    const record = await this.repo.findPasswordResetToken(token, 'PASSWORD_RESET');

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
      await txRepo.setMustChangePassword(record.userId, false);
      await txRepo.markTokenUsed(token);
      await txRepo.deleteUserSessions(record.userId);
      await this.audit.withTx(tx).record({
        tenantId: record.tenantId,
        actorId: record.userId,
        entityType: 'User',
        entityId: record.userId,
        action: AUDIT_ACTION.passwordResetCompleted,
        requestId,
      });
    });

    if (sessionTokens.length > 0) {
      await Promise.all(sessionTokens.map((t) => this.redis.del(sessionCacheKey(t))));
    }
  }

  async setupPassword(
    token: string,
    newPassword: string,
    requestId: string,
  ) {
    const record = await this.repo.findPasswordResetToken(token, 'FIRST_LOGIN_SETUP');

    if (!record) {
      throw new UnauthorizedError('Invalid or expired setup token');
    }

    const expiresAt =
      record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt as string);

    if (expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('Invalid or expired setup token');
    }

    if (record.usedAt !== null) {
      throw new UnauthorizedError('Invalid or expired setup token');
    }

    const passwordHash = await argon2.hash(newPassword);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1_000);

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      await txRepo.updateUserPassword(record.userId, passwordHash);
      await txRepo.setMustChangePassword(record.userId, false);
      await txRepo.markTokenUsed(token);
      await txRepo.deleteUserSessions(record.userId);
      await txRepo.createSession(record.userId, sessionToken, sessionExpiresAt);
      await this.audit.withTx(tx).record({
        tenantId: record.tenantId,
        actorId: record.userId,
        entityType: 'User',
        entityId: record.userId,
        action: AUDIT_ACTION.firstLoginSetupCompleted,
        requestId,
      });
    });

    // No Redis write — the authenticate middleware has a DB fallback and
    // self-populates the cache on the first use of this session token.

    return {
      token: sessionToken,
      user: { name: record.name },
      tenant: { id: record['tenantPublicId'], slug: record['tenantSlug'], name: record['tenantName'] },
    };
  }
}
