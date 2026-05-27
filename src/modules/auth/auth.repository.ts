import type { Transaction } from 'kysely';
import type { AppDb } from '../../shared/db/index.js';
import type { DB, Passwordresettokentype } from '../../types/db.js';

type Executor = AppDb | Transaction<DB>;

export class AuthRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): AuthRepository {
    return new AuthRepository(tx);
  }

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
        'User.mustChangePassword',
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

  async createPasswordResetToken(
    userId: string,
    token: string,
    expiresAt: Date,
    type: Passwordresettokentype = 'PASSWORD_RESET',
  ): Promise<void> {
    await this.exec
      .insertInto('PasswordResetToken')
      .values({ userId, token, expiresAt, type })
      .execute();
  }

  async findPasswordResetToken(token: string, type: Passwordresettokentype) {
    return this.exec
      .selectFrom('PasswordResetToken')
      .innerJoin('User', 'User.id', 'PasswordResetToken.userId')
      .innerJoin('Tenant', 'Tenant.id', 'User.tenantId')
      .select([
        'PasswordResetToken.userId',
        'PasswordResetToken.type',
        'PasswordResetToken.expiresAt',
        'PasswordResetToken.usedAt',
        'User.tenantId',
        'User.email',
        'User.name',
        'Tenant.publicId as tenantPublicId',
        'Tenant.slug as tenantSlug',
        'Tenant.name as tenantName',
      ])
      .where('PasswordResetToken.token', '=', token)
      .where('PasswordResetToken.type', '=', type)
      .executeTakeFirst();
  }

  async markTokenUsed(token: string): Promise<void> {
    await this.exec
      .updateTable('PasswordResetToken')
      .set({ usedAt: new Date() })
      .where('PasswordResetToken.token', '=', token)
      .execute();
  }

  async deleteUnusedPasswordResetTokens(userId: string): Promise<void> {
    await this.exec
      .deleteFrom('PasswordResetToken')
      .where('PasswordResetToken.userId', '=', userId)
      .where('PasswordResetToken.usedAt', 'is', null)
      .execute();
  }

  async getUserSessionTokens(userId: string): Promise<string[]> {
    const rows = await this.exec
      .selectFrom('Session')
      .select('Session.token')
      .where('Session.userId', '=', userId)
      .execute();
    return rows.map((r) => r.token);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.exec
      .deleteFrom('Session')
      .where('Session.userId', '=', userId)
      .execute();
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.exec
      .updateTable('User')
      .set({ password: passwordHash })
      .where('User.id', '=', userId)
      .execute();
  }

  async setMustChangePassword(userId: string, value: boolean): Promise<void> {
    await this.exec
      .updateTable('User')
      .set({ mustChangePassword: value })
      .where('User.id', '=', userId)
      .execute();
  }
}
