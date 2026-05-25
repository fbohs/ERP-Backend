import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { config } from '../../shared/config/index.js';
import { UnauthorizedError } from '../../shared/errors/base.js';
import { logger } from '../../shared/logging/index.js';
import { platformSessionCacheKey, type CachedPlatformSession } from '../../shared/auth/index.js';
import { enqueuePasswordResetEmail, type PasswordResetEmailQueue } from '../auth/index.js';
import { TenantSlugTakenError, TenantNotFoundError } from './platform.errors.js';
import {
  enqueuePlatformLoginEmail,
  type PlatformLoginEmailQueue,
} from './jobs/send-login-link-email.js';
import type { CreateTenantBody } from './platform.schemas.js';
import type { PlatformRepository } from './platform.repository.js';
import type { AuditRepository } from '../../shared/audit/index.js';
import type { AppDb } from '../../shared/db/index.js';
import type { Redis } from '../../shared/cache/redis.js';

const AUDIT_ACTION = {
  tenantCreated: 'platform.tenant_created',
  tenantSuspended: 'platform.tenant_suspended',
  tenantReactivated: 'platform.tenant_reactivated',
} as const;

export interface PlatformActor {
  adminId: string;
}

interface TenantView {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
}

// Postgres unique-violation SQLSTATE — the slug pre-check has a race window, so
// the unique index on Tenant.slug is the real guard; map its error to a 409.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export class PlatformService {
  constructor(
    private readonly repo: PlatformRepository,
    private readonly audit: AuditRepository,
    private readonly redis: Redis,
    private readonly db: AppDb,
    private readonly loginEmailQueue: PlatformLoginEmailQueue | null,
    private readonly onboardingEmailQueue: PasswordResetEmailQueue | null,
    private readonly appBaseUrl: string,
  ) {}

  async requestLoginLink(email: string): Promise<void> {
    logger.info({ email }, 'platform.request-link: received');

    const admin = await this.repo.findAdminByEmail(email);
    // Never reveal whether the email is a known admin — uniform 200 either way.
    const account = admin !== undefined && admin.isActive ? admin : null;
    if (account === null) {
      logger.info({ email }, 'platform.request-link: email not found or admin inactive — returning silently');
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.platformLoginTokenTtlSeconds * 1_000);

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      // Supersede any earlier unused links — only the newest stays live.
      await txRepo.deleteUnusedLoginTokens(account.id);
      await txRepo.createLoginToken(account.id, token, expiresAt);
    });
    logger.info({ adminId: account.publicId }, 'platform.request-link: login token created');

    if (this.loginEmailQueue === null) {
      logger.warn('platform.request-link: email queue is disabled (no RESEND_API_KEY?) — link not sent');
      return;
    }

    const loginUrl = `${this.appBaseUrl}/platform/verify?token=${token}`;
    await enqueuePlatformLoginEmail(this.loginEmailQueue, token, {
      email: account.email,
      name: account.name,
      loginUrl,
    });
    logger.info({ adminId: account.publicId, email: account.email }, 'platform.request-link: login email enqueued');
  }

  async verifyLoginLink(token: string): Promise<{ token: string }> {
    const record = await this.repo.findLoginToken(token);

    if (!record || !record.isActive || record.usedAt !== null) {
      logger.info('platform.verify: token invalid or already used');
      throw new UnauthorizedError('Invalid or expired login link');
    }
    if (toDate(record.expiresAt).getTime() <= Date.now()) {
      logger.info({ adminId: record.adminId }, 'platform.verify: token expired');
      throw new UnauthorizedError('Invalid or expired login link');
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiresAt = new Date(Date.now() + config.platformSessionTtlSeconds * 1_000);

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      await txRepo.createSession(record.adminId, sessionToken, sessionExpiresAt);
      await txRepo.markLoginTokenUsed(token);
    });

    const cached: CachedPlatformSession = { adminId: record.adminId };
    await this.redis.setex(
      platformSessionCacheKey(sessionToken),
      config.platformSessionTtlSeconds,
      JSON.stringify(cached),
    );

    logger.info({ adminId: record.adminId }, 'platform.verify: session created');
    return { token: sessionToken };
  }

  async listTenants() {
    const rows = await this.repo.listTenants();
    return rows.map((tenant) => ({
      id: tenant.publicId,
      slug: tenant.slug,
      name: tenant.name,
      isActive: tenant.isActive,
      plan: tenant.plan,
      createdAt: toDate(tenant.createdAt).toISOString(),
    }));
  }

  async createTenant(input: CreateTenantBody, actor: PlatformActor, requestId: string) {
    const existing = await this.repo.findTenantBySlug(input.tenant.slug);
    if (existing !== undefined) {
      throw new TenantSlugTakenError(`Tenant slug '${input.tenant.slug}' is already taken`);
    }

    // The first admin never gets a usable password from us: an unguessable
    // placeholder hash is stored, and onboarding goes through the standard
    // password-reset ("set your password") flow. See ADR 0002.
    const placeholderPassword = await argon2.hash(crypto.randomBytes(32).toString('hex'));
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpiresAt = new Date(Date.now() + config.passwordResetTtlSeconds * 1_000);

    let tenantPublicId = '';
    try {
      await this.db.transaction().execute(async (tx) => {
        const txRepo = this.repo.withTx(tx);
        const tenant = await txRepo.createTenant(input.tenant.name, input.tenant.slug);
        tenantPublicId = tenant.publicId;
        const user = await txRepo.createUser({
          tenantId: tenant.id,
          email: input.admin.email,
          name: input.admin.name,
          password: placeholderPassword,
          role: 'ADMIN',
        });
        await txRepo.createPasswordResetToken(user.id, resetToken, resetExpiresAt);
        await this.audit.withTx(tx).record({
          tenantId: tenant.id,
          actorId: actor.adminId,
          actorType: 'PLATFORM_ADMIN',
          entityType: 'Tenant',
          entityId: tenant.publicId,
          action: AUDIT_ACTION.tenantCreated,
          after: { slug: tenant.slug, name: tenant.name, adminEmail: input.admin.email },
          requestId,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new TenantSlugTakenError(`Tenant slug '${input.tenant.slug}' is already taken`);
      }
      throw err;
    }

    if (this.onboardingEmailQueue) {
      const resetUrl = `${this.appBaseUrl}/reset-password?token=${resetToken}`;
      await enqueuePasswordResetEmail(this.onboardingEmailQueue, resetToken, {
        email: input.admin.email,
        name: input.admin.name,
        resetUrl,
      });
    }

    return {
      tenant: { id: tenantPublicId, slug: input.tenant.slug, name: input.tenant.name },
      admin: { email: input.admin.email },
    };
  }

  async setTenantActive(
    publicId: string,
    isActive: boolean,
    actor: PlatformActor,
    requestId: string,
  ): Promise<TenantView> {
    const tenant = await this.repo.findTenantByPublicId(publicId);
    if (tenant === undefined) {
      throw new TenantNotFoundError('Tenant not found');
    }

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      await txRepo.setTenantActive(tenant.id, isActive);
      await this.audit.withTx(tx).record({
        tenantId: tenant.id,
        actorId: actor.adminId,
        actorType: 'PLATFORM_ADMIN',
        entityType: 'Tenant',
        entityId: tenant.publicId,
        action: isActive ? AUDIT_ACTION.tenantReactivated : AUDIT_ACTION.tenantSuspended,
        before: { isActive: tenant.isActive },
        after: { isActive },
        requestId,
      });
    });

    return { id: tenant.publicId, slug: tenant.slug, name: tenant.name, isActive };
  }
}
