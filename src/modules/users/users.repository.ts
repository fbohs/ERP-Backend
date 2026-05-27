import type { Transaction } from 'kysely';
import type { AppDb } from '../../shared/db/index.js';
import type { DB, Userrole, Json } from '../../types/db.js';

type Executor = AppDb | Transaction<DB>;

export class UsersRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): UsersRepository {
    return new UsersRepository(tx);
  }

  async insertUser(input: {
    tenantId: string;
    email: string;
    name: string;
    password: string;
    role: Userrole;
    specs: Json | null;
    mustChangePassword: boolean;
  }) {
    return this.exec
      .insertInto('User')
      .values({
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        password: input.password,
        role: input.role,
        specs: input.specs,
        mustChangePassword: input.mustChangePassword,
      })
      .returning(['id', 'publicId', 'email', 'name', 'role'])
      .executeTakeFirstOrThrow();
  }

  async findByPublicId(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('User')
      .select([
        'publicId',
        'email',
        'name',
        'role',
        'isActive',
        'specs',
        'createdAt',
      ])
      .where('publicId', '=', publicId)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  // Used by service to enforce tenant isolation before modifying a row.
  async findInternalIdByPublicId(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('User')
      .select(['id', 'publicId', 'isActive', 'role'])
      .where('publicId', '=', publicId)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async listByTenant(tenantId: string) {
    return this.exec
      .selectFrom('User')
      .select([
        'publicId',
        'email',
        'name',
        'role',
        'isActive',
        'specs',
        'createdAt',
      ])
      .where('tenantId', '=', tenantId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.exec
      .updateTable('User')
      .set({ isActive })
      .where('id', '=', id)
      .execute();
  }

  async findByEmail(email: string, tenantId: string) {
    return this.exec
      .selectFrom('User')
      .select(['id'])
      .where('email', '=', email)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async findTenantNameById(tenantId: string) {
    return this.exec
      .selectFrom('Tenant')
      .select(['name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
  }
}
