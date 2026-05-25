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

  async findAdminById(id: string) {
    return this.exec
      .selectFrom('PlatformAdmin')
      .select(['id', 'isActive'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  // Supersede prior links: issuing a new one leaves only the newest live. Used
  // tokens no longer linger (they are deleted on consumption), so this removes
  // every outstanding token for the admin.
  async deleteLoginTokensForAdmin(adminId: string): Promise<void> {
    await this.exec
      .deleteFrom('PlatformAdminLoginToken')
      .where('adminId', '=', adminId)
      .execute();
  }

  async createLoginToken(adminId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.exec
      .insertInto('PlatformAdminLoginToken')
      .values({ adminId, tokenHash, expiresAt })
      .execute();
  }

  // Atomic single-use consumption: the DELETE returns a row iff the token still
  // existed, so two concurrent verifications cannot both succeed (the second
  // deletes zero rows). Expiry is checked by the caller on the returned row.
  async consumeLoginToken(tokenHash: string) {
    return this.exec
      .deleteFrom('PlatformAdminLoginToken')
      .where('tokenHash', '=', tokenHash)
      .returning(['adminId', 'expiresAt'])
      .executeTakeFirst();
  }

  // Single active session per admin: verification evicts all prior sessions
  // before minting the new one. Also the primitive behind CLI termination.
  async deleteSessionsForAdmin(adminId: string): Promise<void> {
    await this.exec
      .deleteFrom('PlatformAdminSession')
      .where('adminId', '=', adminId)
      .execute();
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.exec
      .deleteFrom('PlatformAdminSession')
      .where('tokenHash', '=', tokenHash)
      .execute();
  }

  async createSession(
    adminId: string,
    tokenHash: string,
    expiresAt: Date,
    ipAddress: string | null,
  ): Promise<void> {
    await this.exec
      .insertInto('PlatformAdminSession')
      .values({ adminId, tokenHash, expiresAt, ipAddress })
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
