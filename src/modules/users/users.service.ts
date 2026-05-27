import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logging/index.js';
import { UserNotFoundError, EmailAlreadyTakenError, CannotModifySelfError } from './users.errors.js';
import {
  enqueueUserWelcomeEmail,
  type UserWelcomeEmailQueue,
} from './jobs/send-user-welcome-email.js';
import type { CreateUserBody } from './users.schemas.js';
import type { UsersRepository } from './users.repository.js';
import type { AuditRepository } from '../../shared/audit/index.js';
import type { AppDb } from '../../shared/db/index.js';

const AUDIT_ACTION = {
  userCreated: 'user.created',
  userSuspended: 'user.suspended',
  userReactivated: 'user.reactivated',
  userDeleted: 'user.deleted',
} as const;

export interface UserActor {
  userId: string;
  tenantId: string;
}

// Cryptographically random alphanumeric password — same algorithm as
// platform.service.ts generateTemporaryPassword.
function generateTemporaryPassword(length = 20): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly db: AppDb,
    private readonly welcomeEmailQueue: UserWelcomeEmailQueue | null,
    private readonly appBaseUrl: string,
  ) {}

  async createUser(input: CreateUserBody, actor: UserActor, requestId: string) {
    const existing = await this.repo.findByEmail(input.email, actor.tenantId);
    if (existing !== undefined) {
      throw new EmailAlreadyTakenError(`Email '${input.email}' is already in use in this tenant`);
    }

    const tenant = await this.repo.findTenantNameById(actor.tenantId);
    const tenantName = tenant?.name ?? 'your organisation';

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await argon2.hash(temporaryPassword);

    let userPublicId = '';

    try {
      await this.db.transaction().execute(async (tx) => {
        const txRepo = this.repo.withTx(tx);
        const user = await txRepo.insertUser({
          tenantId: actor.tenantId,
          email: input.email,
          name: input.name,
          password: passwordHash,
          role: input.role,
          specs: input.specs as import('../../types/db.js').Json | null,
          mustChangePassword: true,
        });
        userPublicId = user.publicId;
        await this.audit.withTx(tx).record({
          tenantId: actor.tenantId,
          actorId: actor.userId,
          entityType: 'User',
          entityId: user.publicId,
          action: AUDIT_ACTION.userCreated,
          after: { email: input.email, role: input.role },
          requestId,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new EmailAlreadyTakenError(`Email '${input.email}' is already in use in this tenant`);
      }
      throw err;
    }

    logger.info({ userPublicId, role: input.role }, 'user.created');

    if (this.welcomeEmailQueue) {
      await enqueueUserWelcomeEmail(this.welcomeEmailQueue, userPublicId, {
        email: input.email,
        name: input.name,
        role: input.role,
        tenantName,
        temporaryPassword,
        loginUrl: `${this.appBaseUrl}/login`,
      });
    }

    return { id: userPublicId, email: input.email, role: input.role };
  }

  async listUsers(actor: UserActor) {
    const rows = await this.repo.listByTenant(actor.tenantId);
    return rows.map(toUserView);
  }

  async getUser(publicId: string, actor: UserActor) {
    const row = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (row === undefined) {
      throw new UserNotFoundError('User not found');
    }
    return toUserView(row);
  }

  async setUserActive(
    publicId: string,
    isActive: boolean,
    actor: UserActor,
    requestId: string,
  ) {
    const user = await this.repo.findInternalIdByPublicId(publicId, actor.tenantId);
    if (user === undefined) {
      throw new UserNotFoundError('User not found');
    }

    if (user.id === actor.userId) {
      throw new CannotModifySelfError('You cannot suspend or reactivate your own account');
    }

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      await txRepo.setActive(user.id, isActive);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'User',
        entityId: publicId,
        action: isActive ? AUDIT_ACTION.userReactivated : AUDIT_ACTION.userSuspended,
        before: { isActive: user.isActive },
        after: { isActive },
        requestId,
      });
    });

    logger.info({ publicId, isActive }, 'user.active-status-changed');

    const updated = await this.repo.findByPublicId(publicId, actor.tenantId);
    return toUserView(updated!);
  }

  async deleteUser(publicId: string, actor: UserActor, requestId: string) {
    const user = await this.repo.findInternalIdByPublicId(publicId, actor.tenantId);
    if (user === undefined) {
      throw new UserNotFoundError('User not found');
    }

    if (user.id === actor.userId) {
      throw new CannotModifySelfError('You cannot delete your own account');
    }

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      await txRepo.setActive(user.id, false);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'User',
        entityId: publicId,
        action: AUDIT_ACTION.userDeleted,
        before: { isActive: user.isActive },
        after: { isActive: false },
        requestId,
      });
    });

    logger.info({ publicId }, 'user.deleted');
  }
}

function toUserView(row: {
  publicId: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  specs: unknown;
  createdAt: Date | string;
}) {
  return {
    id: row.publicId,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    specs: row.specs ?? null,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt as string).toISOString(),
  };
}
