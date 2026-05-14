import type { AppDb } from '../../shared/db/index.js';

export class AuthRepository {
  constructor(private readonly exec: AppDb) {}

  async findUserByEmail(email: string) {
    return this.exec
      .selectFrom('User')
      .innerJoin('Tenant', 'Tenant.id', 'User.tenantId')
      .select([
        'User.id',
        'User.publicId',
        'User.tenantId',
        'User.email',
        'User.name',
        'User.password',
        'User.role',
        'User.isActive',
        'Tenant.publicId as tenantPublicId',
        'Tenant.slug as tenantSlug',
        'Tenant.name as tenantName',
        'Tenant.isActive as tenantIsActive',
      ])
      .where('User.email', '=', email)
      .executeTakeFirst();
  }

  async createSession(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.exec
      .insertInto('Session')
      .values({ userId, token, expiresAt })
      .execute();
  }

  async findSessionWithUser(token: string) {
    return this.exec
      .selectFrom('Session')
      .innerJoin('User', 'User.id', 'Session.userId')
      .innerJoin('Tenant', 'Tenant.id', 'User.tenantId')
      .select([
        'User.id as userId',
        'User.tenantId',
        'User.role',
        'User.isActive',
        'Tenant.isActive as tenantIsActive',
        'Session.expiresAt',
      ])
      .where('Session.token', '=', token)
      .executeTakeFirst();
  }

  async deleteSession(token: string): Promise<void> {
    await this.exec
      .deleteFrom('Session')
      .where('Session.token', '=', token)
      .execute();
  }
}
