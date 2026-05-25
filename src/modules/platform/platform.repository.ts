import type { Transaction } from 'kysely';
import type { AppDb } from '../../shared/db/index.js';
import type { DB, Userrole } from '../../types/db.js';

type Executor = AppDb | Transaction<DB>;

export class PlatformRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): PlatformRepository {
    return new PlatformRepository(tx);
  }

  async findAdminByEmail(email: string) {
    return this.exec
      .selectFrom('PlatformAdmin')
      .select(['id', 'publicId', 'email', 'name', 'isActive'])
      .where('email', '=', email)
      .executeTakeFirst();
  }

  async deleteUnusedLoginTokens(adminId: string): Promise<void> {
    await this.exec
      .deleteFrom('PlatformAdminLoginToken')
      .where('adminId', '=', adminId)
      .where('usedAt', 'is', null)
      .execute();
  }

  async createLoginToken(adminId: string, token: string, expiresAt: Date): Promise<void> {
    await this.exec
      .insertInto('PlatformAdminLoginToken')
      .values({ adminId, token, expiresAt })
      .execute();
  }

  async findLoginToken(token: string) {
    return this.exec
      .selectFrom('PlatformAdminLoginToken')
      .innerJoin('PlatformAdmin', 'PlatformAdmin.id', 'PlatformAdminLoginToken.adminId')
      .select([
        'PlatformAdminLoginToken.adminId',
        'PlatformAdminLoginToken.expiresAt',
        'PlatformAdminLoginToken.usedAt',
        'PlatformAdmin.isActive',
      ])
      .where('PlatformAdminLoginToken.token', '=', token)
      .executeTakeFirst();
  }

  async markLoginTokenUsed(token: string): Promise<void> {
    await this.exec
      .updateTable('PlatformAdminLoginToken')
      .set({ usedAt: new Date() })
      .where('token', '=', token)
      .execute();
  }

  async createSession(adminId: string, token: string, expiresAt: Date): Promise<void> {
    await this.exec
      .insertInto('PlatformAdminSession')
      .values({ adminId, token, expiresAt })
      .execute();
  }

  async findTenantBySlug(slug: string) {
    return this.exec
      .selectFrom('Tenant')
      .select(['id', 'publicId', 'slug'])
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  async createTenant(name: string, slug: string) {
    return this.exec
      .insertInto('Tenant')
      .values({ name, slug })
      .returning(['id', 'publicId', 'slug', 'name'])
      .executeTakeFirstOrThrow();
  }

  async createUser(input: {
    tenantId: string;
    email: string;
    name: string;
    password: string;
    role: Userrole;
  }) {
    return this.exec
      .insertInto('User')
      .values({
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        password: input.password,
        role: input.role,
      })
      .returning(['id', 'publicId'])
      .executeTakeFirstOrThrow();
  }

  async createPasswordResetToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.exec
      .insertInto('PasswordResetToken')
      .values({ userId, token, expiresAt })
      .execute();
  }

  // Cross-tenant by design: this is a PLATFORM read across all tenants, not a
  // tenant-scoped business query, so it intentionally has no tenantId filter.
  // The "tenant-scoped query" P0 rule governs business tables. See ADR 0002.
  async listTenants() {
    return this.exec
      .selectFrom('Tenant')
      .select(['publicId', 'slug', 'name', 'isActive', 'plan', 'createdAt'])
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async findTenantByPublicId(publicId: string) {
    return this.exec
      .selectFrom('Tenant')
      .select(['id', 'publicId', 'slug', 'name', 'isActive'])
      .where('publicId', '=', publicId)
      .executeTakeFirst();
  }

  async setTenantActive(id: string, isActive: boolean): Promise<void> {
    await this.exec
      .updateTable('Tenant')
      .set({ isActive })
      .where('id', '=', id)
      .execute();
  }
}
