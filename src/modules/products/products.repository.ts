import type { Transaction } from 'kysely';
import type { AppDb } from '@/shared/db/index.js';
import type { DB, Productstatus } from '@/types/db.js';

type Executor = AppDb | Transaction<DB>;

const PRODUCT_COLS = [
  'Product.id',
  'Product.publicId',
  'Product.tenantId',
  'Product.sku',
  'Product.name',
  'Product.slug',
  'Product.description',
  'Product.type',
  'Product.status',
  'Product.tags',
  'Product.hsnCode',
  'Product.isPublished',
  'Product.isSuspendedByOperator',
  'Product.verificationStatus',
  'Product.merchantId',
  'Product.createdAt',
  'Product.updatedAt',
] as const;

const VARIANT_COLS = [
  'id',
  'publicId',
  'productId',
  'sku',
  'listPrice',
  'compareAtPrice',
  'standardCost',
  'isActive',
  'createdAt',
  'updatedAt',
] as const;

export class ProductsRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): ProductsRepository {
    return new ProductsRepository(tx);
  }

  async insert(input: {
    tenantId: string;
    sku: string;
    name: string;
    slug: string;
    description: string | null;
    type: 'GOODS' | 'SERVICE';
    categoryId: string;
    uomId: string;
    tags: string[];
    hsnCode: string | null;
    merchantId: string | null;
    createdById: string | null;
  }) {
    return this.exec
      .insertInto('Product')
      .values({
        tenantId: input.tenantId,
        sku: input.sku,
        name: input.name,
        slug: input.slug,
        description: input.description,
        type: input.type,
        categoryId: input.categoryId,
        uomId: input.uomId,
        tags: input.tags,
        hsnCode: input.hsnCode,
        merchantId: input.merchantId,
        createdById: input.createdById,
      })
      .returning(['id', 'publicId'])
      .executeTakeFirstOrThrow();
  }

  async insertVariant(input: {
    tenantId: string;
    productId: string;
    sku: string;
    uomId: string;
    listPrice: string;
    compareAtPrice: string | null;
  }) {
    return this.exec
      .insertInto('ProductVariant')
      .values({
        tenantId: input.tenantId,
        productId: input.productId,
        sku: input.sku,
        uomId: input.uomId,
        listPrice: input.listPrice,
        compareAtPrice: input.compareAtPrice,
      })
      .returning(VARIANT_COLS)
      .executeTakeFirstOrThrow();
  }

  async findByPublicId(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('Product')
      .innerJoin('Category', 'Category.id', 'Product.categoryId')
      .innerJoin('UnitOfMeasure', 'UnitOfMeasure.id', 'Product.uomId')
      .select([...PRODUCT_COLS, 'Category.publicId as categoryPublicId', 'UnitOfMeasure.code as uomCode', 'Product.media'])
      .where('Product.publicId', '=', publicId)
      .where('Product.tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async listByTenant(
    tenantId: string,
    filters: { status?: Productstatus; internalCategoryId?: string },
  ) {
    return this.exec
      .selectFrom('Product')
      .innerJoin('Category', 'Category.id', 'Product.categoryId')
      .innerJoin('UnitOfMeasure', 'UnitOfMeasure.id', 'Product.uomId')
      .select([...PRODUCT_COLS, 'Category.publicId as categoryPublicId', 'UnitOfMeasure.code as uomCode'])
      .where('Product.tenantId', '=', tenantId)
      .$if(filters.status !== undefined, (qb) => qb.where('Product.status', '=', filters.status!))
      .$if(filters.internalCategoryId !== undefined, (qb) =>
        qb.where('Product.categoryId', '=', filters.internalCategoryId!),
      )
      .orderBy('Product.name', 'asc')
      .execute();
  }

  async listVariantsByProductId(productId: string) {
    return this.exec
      .selectFrom('ProductVariant')
      .select(VARIANT_COLS)
      .where('productId', '=', productId)
      .orderBy('id', 'asc')
      .execute();
  }

  async findVariantByPublicId(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('ProductVariant')
      .select(VARIANT_COLS)
      .where('publicId', '=', publicId)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async findBySlug(slug: string, tenantId: string, excludePublicId?: string) {
    let q = this.exec
      .selectFrom('Product')
      .select(['id'])
      .where('slug', '=', slug)
      .where('tenantId', '=', tenantId);
    if (excludePublicId !== undefined) {
      q = q.where('publicId', '!=', excludePublicId);
    }
    return q.executeTakeFirst();
  }

  async findBySku(sku: string, tenantId: string, excludePublicId?: string) {
    let q = this.exec
      .selectFrom('Product')
      .select(['id'])
      .where('sku', '=', sku)
      .where('tenantId', '=', tenantId);
    if (excludePublicId !== undefined) {
      q = q.where('publicId', '!=', excludePublicId);
    }
    return q.executeTakeFirst();
  }

  async findVariantBySku(sku: string, tenantId: string, excludePublicId?: string) {
    let q = this.exec
      .selectFrom('ProductVariant')
      .select(['id'])
      .where('sku', '=', sku)
      .where('tenantId', '=', tenantId);
    if (excludePublicId !== undefined) {
      q = q.where('publicId', '!=', excludePublicId);
    }
    return q.executeTakeFirst();
  }

  async updateProduct(
    id: string,
    patch: {
      name?: string;
      sku?: string;
      slug?: string;
      description?: string | null;
      type?: 'GOODS' | 'SERVICE';
      status?: Productstatus;
      categoryId?: string;
      uomId?: string;
      tags?: string[];
      hsnCode?: string | null;
      isPublished?: boolean;
      isSuspendedByOperator?: boolean;
    },
  ): Promise<void> {
    await this.exec.updateTable('Product').set(patch).where('id', '=', id).execute();
  }

  async updateVariant(
    id: string,
    patch: {
      sku?: string;
      listPrice?: string;
      compareAtPrice?: string | null;
      standardCost?: string | null;
      isActive?: boolean;
    },
  ): Promise<void> {
    await this.exec.updateTable('ProductVariant').set(patch).where('id', '=', id).execute();
  }

  async findCategoryById(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('Category')
      .select(['id', 'isActive'])
      .where('publicId', '=', publicId)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async findUomByCode(code: string) {
    return this.exec
      .selectFrom('UnitOfMeasure')
      .select(['id', 'code'])
      .where('code', '=', code)
      .where('isActive', '=', true)
      .executeTakeFirst();
  }

  async findProductMedia(publicId: string, tenantId: string) {
    return this.exec
      .selectFrom('Product')
      .select(['id', 'media'])
      .where('publicId', '=', publicId)
      .where('tenantId', '=', tenantId)
      .executeTakeFirst();
  }

  async setMedia(id: string, media: unknown[]): Promise<void> {
    await this.exec
      .updateTable('Product')
      .set({ media: JSON.stringify(media) })
      .where('id', '=', id)
      .execute();
  }
}
