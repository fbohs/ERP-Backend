import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { config } from '../../shared/config/index.js';
import { UnauthorizedError } from '../../shared/errors/base.js';
import { logger } from '../../shared/logging/index.js';
import { hashToken } from '../../shared/auth/index.js';
import { TenantSlugTakenError, TenantNotFoundError } from './platform.errors.js';
import {
  enqueuePlatformLoginEmail,
  type PlatformLoginEmailQueue,
} from './jobs/send-login-link-email.js';
import {
  enqueueTenantWelcomeEmail,
  type TenantWelcomeEmailQueue,
} from './jobs/send-tenant-welcome-email.js';
import type { CreateTenantBody } from './platform.schemas.js';
import type { PlatformRepository } from './platform.repository.js';
import type { AuditRepository, PlatformAuditRepository } from '../../shared/audit/index.js';
import type { AppDb } from '../../shared/db/index.js';

// Tenant-scoped platform actions — recorded in the tenant AuditLog (they carry
// the target tenant's id).
const AUDIT_ACTION = {
  tenantCreated: 'platform.tenant_created',
  tenantSuspended: 'platform.tenant_suspended',
  tenantReactivated: 'platform.tenant_reactivated',
} as const;

// Platform-GLOBAL actions — no tenant — recorded in PlatformAuditLog.
const PLATFORM_AUDIT_ACTION = {
  loginLinkRequested: 'platform.login_link_requested',
  login: 'platform.login',
  logout: 'platform.logout',
} as const;

export interface PlatformActor {
  adminId: string;
}

interface TenantView {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  plan: string;
  createdAt: string;
}

// Postgres unique-violation SQLSTATE — the slug pre-check has a race window, so
// the unique index on Tenant.slug is the real guard; map its error to a 409.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// Generates a cryptographically random alphanumeric password of the given
// length. Uses rejection sampling to stay uniform over [A-Za-z0-9].
function generateTemporaryPassword(length = 20): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  // Rejection sampling: discard bytes that fall outside the usable range to
  // avoid modulo bias. The usable range covers 99.6% of byte values at 62
  // chars, so rejection is rare.
  const limit = 256 - (256 % chars.length);
  while (result.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const byte of bytes) {
      if (byte < limit) {
        result += chars[byte % chars.length];
        if (result.length === length) break;
      }
    }
  }
  return result;
}

export class PlatformService {
  constructor(
    private readonly repo: PlatformRepository,
    private readonly audit: AuditRepository,
    private readonly platformAudit: PlatformAuditRepository,
    private readonly db: AppDb,
    private readonly loginEmailQueue: PlatformLoginEmailQueue | null,
    private readonly welcomeEmailQueue: TenantWelcomeEmailQueue | null,
    private readonly appBaseUrl: string,
  ) {}

  async requestLoginLink(email: string, ipAddress: string | null): Promise<void> {
    logger.info({ email }, 'platform.request-link: received');

    const admin = await this.repo.findAdminByEmail(email);
    // Never reveal whether the email is a known admin — uniform 200 either way.
    const account = admin !== undefined && admin.isActive ? admin : null;

    // Enumeration defense: generate the token and open the transaction
    // UNCONDITIONALLY, so a known and an unknown email cost the same. Only the
    // body of the transaction differs. (Mirrors auth.forgotPassword.) Storing
    // only the hash means a DB leak yields no usable link.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + config.platformLoginTokenTtlSeconds * 1_000);

    await this.db.transaction().execute(async (tx) => {
      if (account === null) {
        return;
      }
      const txRepo = this.repo.withTx(tx);
      // Supersede any earlier links — only the newest stays live.
      await txRepo.deleteLoginTokensForAdmin(account.id);
      await txRepo.createLoginToken(account.id, tokenHash, expiresAt);
      await this.platformAudit.withTx(tx).record({
        adminId: account.id,
        action: PLATFORM_AUDIT_ACTION.loginLinkRequested,
        ipAddress,
      });
    });

    if (account === null) {
      logger.info({ email }, 'platform.request-link: unknown/inactive admin — returning silently');
      return;
    }
    logger.info({ adminId: account.publicId }, 'platform.request-link: login token created');

    if (this.loginEmailQueue === null) {
      logger.warn('platform.request-link: email queue is disabled (no RESEND_API_KEY?) — link not sent');
      return;
    }

    const loginUrl = `${this.appBaseUrl}/platform/verify?token=${rawToken}`;
    await enqueuePlatformLoginEmail(this.loginEmailQueue, rawToken, {
      email: account.email,
      name: account.name,
      loginUrl,
    });
    logger.info({ adminId: account.publicId, email: account.email }, 'platform.request-link: login email enqueued');
  }

  async verifyLoginLink(rawToken: string, ipAddress: string | null): Promise<{ token: string }> {
    const tokenHash = hashToken(rawToken);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionTokenHash = hashToken(sessionToken);
    const sessionExpiresAt = new Date(Date.now() + config.platformSessionTtlSeconds * 1_000);

    const adminId = await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);

      // Atomic single-use: the DELETE returns the row iff the token was still
      // live, so two concurrent verifications cannot both mint a session.
      const consumed = await txRepo.consumeLoginToken(tokenHash);
      if (!consumed) {
        return null;
      }
      if (toDate(consumed.expiresAt).getTime() <= Date.now()) {
        return null;
      }
      const admin = await txRepo.findAdminById(consumed.adminId);
      if (!admin || !admin.isActive) {
        return null;
      }

      // Single active session: a new login evicts any existing sessions.
      await txRepo.deleteSessionsForAdmin(consumed.adminId);
      await txRepo.createSession(consumed.adminId, sessionTokenHash, sessionExpiresAt, ipAddress);
      await this.platformAudit.withTx(tx).record({
        adminId: consumed.adminId,
        action: PLATFORM_AUDIT_ACTION.login,
        targetType: 'PlatformAdminSession',
        ipAddress,
      });
      return consumed.adminId;
    });

    if (adminId === null) {
      logger.info('platform.verify: token invalid, expired, already used, or admin inactive');
      throw new UnauthorizedError('Invalid or expired login link');
    }

    logger.info({ adminId }, 'platform.verify: session created');
    return { token: sessionToken };
  }

  async logout(
    rawToken: string,
    actor: PlatformActor,
    ipAddress: string | null,
    requestId: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      await txRepo.deleteSessionByTokenHash(hashToken(rawToken));
      await this.platformAudit.withTx(tx).record({
        adminId: actor.adminId,
        action: PLATFORM_AUDIT_ACTION.logout,
        targetType: 'PlatformAdminSession',
        ipAddress,
        requestId,
      });
    });
    logger.info({ adminId: actor.adminId }, 'platform.logout: session cleared');
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

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await argon2.hash(temporaryPassword);

    let tenantPublicId = '';
    try {
      await this.db.transaction().execute(async (tx) => {
        const txRepo = this.repo.withTx(tx);
        const tenant = await txRepo.createTenant(input.tenant.name, input.tenant.slug);
        tenantPublicId = tenant.publicId;
        await txRepo.createUser({
          tenantId: tenant.id,
          email: input.admin.email,
          name: input.admin.name,
          password: passwordHash,
          role: 'ADMIN',
          mustChangePassword: true,
        });
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

    if (this.welcomeEmailQueue) {
      const loginUrl = `${this.appBaseUrl}/login`;
      await enqueueTenantWelcomeEmail(this.welcomeEmailQueue, tenantPublicId, {
        email: input.admin.email,
        name: input.admin.name,
        tenantName: input.tenant.name,
        temporaryPassword,
        loginUrl,
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

    return {
      id: tenant.publicId,
      slug: tenant.slug,
      name: tenant.name,
      isActive,
      plan: tenant.plan,
      createdAt: toDate(tenant.createdAt).toISOString(),
    };
  }

  async getTenant(publicId: string): Promise<TenantView> {
    const tenant = await this.repo.findTenantByPublicId(publicId);
    if (tenant === undefined) {
      throw new TenantNotFoundError('Tenant not found');
    }
    return {
      id: tenant.publicId,
      slug: tenant.slug,
      name: tenant.name,
      isActive: tenant.isActive,
      plan: tenant.plan,
      createdAt: toDate(tenant.createdAt).toISOString(),
    };
  }
}
