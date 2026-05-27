import type { Transaction } from 'kysely';
import type { AppDb } from '../../shared/db/index.js';
import type { DB } from '../../types/db.js';

type Executor = AppDb | Transaction<DB>;

const COLS = [
  'id',
  'publicId',
  'name',
  'slug',
  'description',
  'isActive',
  'parentId',
  'createdAt',
  'updatedAt',
] as const;

export class CategoriesRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): CategoriesRepository {
    return new CategoriesRepository(tx);
  }

  async insert(input: {
    tenantId: string;
    name: string;
    slug: string;
    description: string | null;
    parentId: string | null;
  }) {
    return this.exec
      .insertInto('Category')
      .values({
        tenantId: input.tenantId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        parentId: input.parentId,
      })
      .returning(COLS)
      .executeTakeFirstOrThrow();
  }

  async findByPublicId(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('Category')
      .select(COLS)
      .where('publicId', '=', publicId)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  // Used to resolve a parent's publicId when constructing a single CategoryView.
  async findPublicIdById(id: string, tenantId: string) {
    return this.exec
      .selectFrom('Category')
      .select(['publicId'])
      .where('id', '=', id)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async findBySlug(slug: string, tenantId: string, excludePublicId?: string) {
    let q = this.exec
      .selectFrom('Category')
      .select(['id'])
      .where('slug', '=', slug)
      .where('tenantId', '=', tenantId);
    if (excludePublicId !== undefined) {
      q = q.where('publicId', '!=', excludePublicId);
    }
    return q.executeTakeFirst();
  }

  async listByTenant(tenantId: string) {
    return this.exec
      .selectFrom('Category')
      .select(COLS)
      .where('tenantId', '=', tenantId)
      .orderBy('name', 'asc')
      .execute();
  }

  async update(
    id: string,
    patch: {
      name?: string;
      slug?: string;
      description?: string | null;
      parentId?: string | null;
      isActive?: boolean;
    },
  ): Promise<void> {
    const set: {
      name?: string;
      slug?: string;
      description?: string | null;
      parentId?: string | null;
      isActive?: boolean;
    } = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.slug !== undefined) set.slug = patch.slug;
    if (patch.description !== undefined) set.description = patch.description;
    if ('parentId' in patch) set.parentId = patch.parentId;
    if (patch.isActive !== undefined) set.isActive = patch.isActive;

    await this.exec
      .updateTable('Category')
      .set(set)
      .where('id', '=', id)
      .execute();
  }

  // Returns true if any DRAFT or READY product references this category.
  // ARCHIVED and DISCONTINUED products are excluded — they do not block deactivation.
  async hasLiveProducts(id: string): Promise<boolean> {
    const row = await this.exec
      .selectFrom('Product')
      .select('id')
      .where('categoryId', '=', id)
      .where('status', 'in', ['DRAFT', 'READY'])
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}
