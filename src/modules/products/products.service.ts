import * as crypto from 'node:crypto';
import { logger } from '../../shared/logging/index.js';
import {
  ProductNotFoundError,
  ProductSkuExistsError,
  ProductSlugExistsError,
  VariantSkuExistsError,
  InvalidCategoryError,
  InvalidUomError,
  ProductImageNotUploadedError,
  ProductImageTooLargeError,
  ProductImageKeyMismatchError,
  ProductImagePrimaryRequiredError,
  ProductImageReorderMismatchError,
  ProductImageNotFoundError,
} from './products.errors.js';
import { ForbiddenError } from '../../shared/errors/base.js';
import type { CreateProductBody, UpdateProductBody, UpdateVariantBody } from './products.schemas.js';
import type { ProductsRepository } from './products.repository.js';
import type { AuditRepository } from '../../shared/audit/index.js';
import type { AppDb } from '../../shared/db/index.js';
import type { ProductView, ProductListView, VariantView, ProductActor, MediaEntry, PresignImageView } from './products.types.js';
import type { Productstatus } from '../../types/db.js';
import {
  generatePresignedPutUrl,
  getObjectMeta,
  buildObjectUrl,
  isAllowedMimeType,
  MAX_IMAGE_SIZE_BYTES,
} from '../../shared/storage/index.js';

const AUDIT = {
  created: 'product.created',
  updated: 'product.updated',
  variantUpdated: 'product.variant_updated',
  published: 'product.published',
  unpublished: 'product.unpublished',
  suspended: 'product.suspended',
  unsuspended: 'product.unsuspended',
  imagesConfirmed: 'product.images_confirmed',
  imagesReordered: 'product.images_reordered',
  imagePrimarySet: 'product.image_primary_set',
} as const;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

type ProductRow = Awaited<ReturnType<ProductsRepository['findByPublicId']>>;
type ProductListRow = Awaited<ReturnType<ProductsRepository['listByTenant']>>[number];
type VariantRow = Awaited<ReturnType<ProductsRepository['listVariantsByProductId']>>[number];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toVariantView(row: VariantRow): VariantView {
  return {
    id: row.publicId,
    sku: row.sku,
    listPrice: row.listPrice,
    compareAtPrice: row.compareAtPrice ?? null,
    standardCost: row.standardCost ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

function toListView(row: ProductListRow, isAdmin: boolean): ProductListView {
  const view: ProductListView = {
    id: row.publicId,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    type: row.type,
    status: row.status,
    categoryId: row.categoryPublicId,
    uomCode: row.uomCode,
    tags: row.tags,
    hsnCode: row.hsnCode ?? null,
    isPublished: row.isPublished,
    verificationStatus: row.verificationStatus,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
  if (isAdmin) view.isSuspendedByOperator = row.isSuspendedByOperator;
  return view;
}

export class ProductsService {
  constructor(
    private readonly repo: ProductsRepository,
    private readonly audit: AuditRepository,
    private readonly db: AppDb,
  ) {}

  private async resolveCategory(categoryId: string, tenantId: string): Promise<string> {
    const cat = await this.repo.findCategoryById(categoryId, tenantId);
    if (!cat || !cat.isActive) throw new InvalidCategoryError('Category not found or inactive');
    return cat.id;
  }

  private async resolveUom(uomCode: string): Promise<string> {
    const uom = await this.repo.findUomByCode(uomCode);
    if (!uom) throw new InvalidUomError(`UOM code '${uomCode}' not found`);
    return uom.id;
  }

  async create(input: CreateProductBody, actor: ProductActor, requestId: string): Promise<ProductView> {
    const [slugConflict, skuConflict] = await Promise.all([
      this.repo.findBySlug(input.slug ?? slugify(input.name), actor.tenantId),
      this.repo.findBySku(input.sku, actor.tenantId),
    ]);
    if (slugConflict) throw new ProductSlugExistsError(`Slug '${input.slug ?? slugify(input.name)}' is already in use`);
    if (skuConflict) throw new ProductSkuExistsError(`SKU '${input.sku}' is already in use`);

    const variantSku = input.variantSku ?? input.sku;
    if (variantSku !== input.sku) {
      const variantSkuConflict = await this.repo.findVariantBySku(variantSku, actor.tenantId);
      if (variantSkuConflict) throw new VariantSkuExistsError(`Variant SKU '${variantSku}' is already in use`);
    }

    const [internalCategoryId, internalUomId] = await Promise.all([
      this.resolveCategory(input.categoryId, actor.tenantId),
      this.resolveUom(input.uomCode),
    ]);

    const slug = input.slug ?? slugify(input.name);
    const isMerchant = actor.role === 'MERCHANT';

    let createdPublicId!: string;

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      const product = await txRepo.insert({
        tenantId: actor.tenantId,
        sku: input.sku,
        name: input.name,
        slug,
        description: input.description ?? null,
        type: input.type ?? 'GOODS',
        categoryId: internalCategoryId,
        uomId: internalUomId,
        tags: input.tags ?? [],
        hsnCode: input.hsnCode ?? null,
        merchantId: isMerchant ? actor.userId : null,
        createdById: actor.userId,
      });

      await txRepo.insertVariant({
        tenantId: actor.tenantId,
        productId: product.id,
        sku: variantSku,
        uomId: internalUomId,
        listPrice: input.listPrice,
        compareAtPrice: input.compareAtPrice ?? null,
      });

      createdPublicId = product.publicId;

      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: product.publicId,
        action: AUDIT.created,
        after: { sku: input.sku, name: input.name, slug, categoryId: input.categoryId },
        requestId,
      });
    });

    logger.info({ id: createdPublicId }, 'product.created');
    return this.get(createdPublicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async list(
    tenantId: string,
    filters: { status?: string; categoryId?: string },
    isAdmin: boolean,
  ): Promise<ProductListView[]> {
    let internalCategoryId: string | undefined;
    if (filters.categoryId) {
      const cat = await this.repo.findCategoryById(filters.categoryId, tenantId);
      internalCategoryId = cat?.id;
      // Unknown categoryId returns empty list rather than an error — consistent with filter semantics.
    }

    const repoFilters: { status?: Productstatus; internalCategoryId?: string } = {};
    if (filters.status !== undefined) repoFilters.status = filters.status as Productstatus;
    if (internalCategoryId !== undefined) repoFilters.internalCategoryId = internalCategoryId;

    const rows = await this.repo.listByTenant(tenantId, repoFilters);

    return rows.map((r) => toListView(r, isAdmin));
  }

  async get(publicId: string, tenantId: string, isAdmin: boolean): Promise<ProductView> {
    const row = await this.repo.findByPublicId(publicId, tenantId);
    if (!row) throw new ProductNotFoundError('Product not found');

    const variantRows = await this.repo.listVariantsByProductId(row.id);
    const media: MediaEntry[] = Array.isArray(row.media) ? (row.media as unknown as MediaEntry[]) : [];

    return {
      ...toListView(row, isAdmin),
      variants: variantRows.map(toVariantView),
      media,
    };
  }

  async update(
    publicId: string,
    input: UpdateProductBody,
    actor: ProductActor,
    requestId: string,
  ): Promise<ProductView> {
    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new ProductNotFoundError('Product not found');

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const conflict = await this.repo.findBySlug(input.slug, actor.tenantId, publicId);
      if (conflict) throw new ProductSlugExistsError(`Slug '${input.slug}' is already in use`);
    }

    if (input.sku !== undefined && input.sku !== existing.sku) {
      const conflict = await this.repo.findBySku(input.sku, actor.tenantId, publicId);
      if (conflict) throw new ProductSkuExistsError(`SKU '${input.sku}' is already in use`);
    }

    const patch: Parameters<ProductsRepository['updateProduct']>[1] = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.sku !== undefined) patch.sku = input.sku;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.description !== undefined) patch.description = input.description;
    if (input.type !== undefined) patch.type = input.type;
    if (input.status !== undefined) patch.status = input.status as Productstatus;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.hsnCode !== undefined) patch.hsnCode = input.hsnCode;

    if (input.categoryId !== undefined) {
      patch.categoryId = await this.resolveCategory(input.categoryId, actor.tenantId);
    }
    if (input.uomCode !== undefined) {
      patch.uomId = await this.resolveUom(input.uomCode);
    }

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).updateProduct(existing.id, patch);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: publicId,
        action: AUDIT.updated,
        before: { sku: existing.sku, name: existing.name, status: existing.status },
        after: input,
        requestId,
      });
    });

    logger.info({ publicId }, 'product.updated');
    return this.get(publicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async updateVariant(
    productPublicId: string,
    variantPublicId: string,
    input: UpdateVariantBody,
    actor: ProductActor,
    requestId: string,
  ): Promise<ProductView> {
    const product = await this.repo.findByPublicId(productPublicId, actor.tenantId);
    if (!product) throw new ProductNotFoundError('Product not found');

    const variant = await this.repo.findVariantByPublicId(variantPublicId, actor.tenantId);
    if (!variant || variant.productId !== product.id) throw new ProductNotFoundError('Variant not found');

    if (input.sku !== undefined && input.sku !== variant.sku) {
      const conflict = await this.repo.findVariantBySku(input.sku, actor.tenantId, variantPublicId);
      if (conflict) throw new VariantSkuExistsError(`Variant SKU '${input.sku}' is already in use`);
    }

    const patch: Parameters<ProductsRepository['updateVariant']>[1] = {};
    if (input.sku !== undefined) patch.sku = input.sku;
    if (input.listPrice !== undefined) patch.listPrice = input.listPrice;
    if (input.compareAtPrice !== undefined) patch.compareAtPrice = input.compareAtPrice;
    if (input.standardCost !== undefined) patch.standardCost = input.standardCost;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).updateVariant(variant.id, patch);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'ProductVariant',
        entityId: variantPublicId,
        action: AUDIT.variantUpdated,
        before: { sku: variant.sku, listPrice: variant.listPrice },
        after: input,
        requestId,
      });
    });

    logger.info({ variantPublicId }, 'product.variant_updated');
    return this.get(productPublicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async publish(publicId: string, actor: ProductActor, requestId: string): Promise<ProductView> {
    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new ProductNotFoundError('Product not found');

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).updateProduct(existing.id, { isPublished: true });
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: publicId,
        action: AUDIT.published,
        before: { isPublished: false },
        after: { isPublished: true },
        requestId,
      });
    });

    logger.info({ publicId }, 'product.published');
    return this.get(publicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async unpublish(publicId: string, actor: ProductActor, requestId: string): Promise<ProductView> {
    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new ProductNotFoundError('Product not found');

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).updateProduct(existing.id, { isPublished: false });
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: publicId,
        action: AUDIT.unpublished,
        before: { isPublished: true },
        after: { isPublished: false },
        requestId,
      });
    });

    logger.info({ publicId }, 'product.unpublished');
    return this.get(publicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async suspend(publicId: string, actor: ProductActor, requestId: string): Promise<ProductView> {
    if (actor.role !== 'ADMIN') throw new ForbiddenError('Only ADMIN can suspend products');

    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new ProductNotFoundError('Product not found');

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).updateProduct(existing.id, { isSuspendedByOperator: true });
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: publicId,
        action: AUDIT.suspended,
        before: { isSuspendedByOperator: false },
        after: { isSuspendedByOperator: true },
        requestId,
      });
    });

    logger.info({ publicId }, 'product.suspended');
    return this.get(publicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async unsuspend(publicId: string, actor: ProductActor, requestId: string): Promise<ProductView> {
    if (actor.role !== 'ADMIN') throw new ForbiddenError('Only ADMIN can unsuspend products');

    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new ProductNotFoundError('Product not found');

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).updateProduct(existing.id, { isSuspendedByOperator: false });
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: publicId,
        action: AUDIT.unsuspended,
        before: { isSuspendedByOperator: true },
        after: { isSuspendedByOperator: false },
        requestId,
      });
    });

    logger.info({ publicId }, 'product.unsuspended');
    return this.get(publicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async presignImageUpload(
    productPublicId: string,
    mimeType: string,
    actor: ProductActor,
  ): Promise<PresignImageView> {
    if (!isAllowedMimeType(mimeType)) {
      throw new ProductImageKeyMismatchError(
        'mimeType must be image/jpeg, image/png, or image/webp',
      );
    }

    const product = await this.repo.findByPublicId(productPublicId, actor.tenantId);
    if (!product) throw new ProductNotFoundError('Product not found');

    const ext = MIME_TO_EXT[mimeType];
    const s3Key = `products/${productPublicId}/${crypto.randomUUID()}.${ext}`;

    const { uploadUrl, expiresAt } = await generatePresignedPutUrl(s3Key, mimeType);

    logger.info({ productPublicId, s3Key }, 'product.image_presigned');
    return { s3Key, uploadUrl, expiresAt: expiresAt.toISOString() };
  }

  async confirmImages(
    productPublicId: string,
    input: {
      primary?: { s3Key: string; altText: string | null };
      others: Array<{ s3Key: string; altText: string | null }>;
    },
    actor: ProductActor,
    requestId: string,
  ): Promise<ProductView> {
    const allNew = [
      ...(input.primary ? [input.primary] : []),
      ...input.others,
    ];

    for (const img of allNew) {
      if (!img.s3Key.startsWith(`products/${productPublicId}/`)) {
        throw new ProductImageKeyMismatchError('s3Key does not belong to this product');
      }
    }

    const row = await this.repo.findProductMedia(productPublicId, actor.tenantId);
    if (!row) throw new ProductNotFoundError('Product not found');

    const existing: MediaEntry[] = Array.isArray(row.media) ? (row.media as unknown as MediaEntry[]) : [];

    if (!input.primary && existing.length === 0) {
      throw new ProductImagePrimaryRequiredError(
        'A primary image is required when the product has no existing images',
      );
    }

    const metas = await Promise.all(allNew.map((img) => getObjectMeta(img.s3Key)));

    for (let i = 0; i < allNew.length; i++) {
      const meta = metas[i]!;
      if (!meta) throw new ProductImageNotUploadedError(`Image has not been uploaded to S3 yet: ${allNew[i]!.s3Key}`);
      if (meta.sizeBytes > MAX_IMAGE_SIZE_BYTES) {
        throw new ProductImageTooLargeError(
          `Image exceeds the 5 MB limit (${allNew[i]!.s3Key}): ${(meta.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
        );
      }
    }

    const baseOrder = existing.length;
    const primaryOffset = input.primary ? 1 : 0;

    const newPrimary: MediaEntry | undefined = input.primary
      ? {
          s3Key: input.primary.s3Key,
          url: buildObjectUrl(input.primary.s3Key),
          altText: input.primary.altText,
          mediaType: 'image',
          sortOrder: baseOrder,
          isPrimary: true,
        }
      : undefined;

    const newOthers: MediaEntry[] = input.others.map((img, i) => ({
      s3Key: img.s3Key,
      url: buildObjectUrl(img.s3Key),
      altText: img.altText,
      mediaType: 'image',
      sortOrder: baseOrder + primaryOffset + i,
      isPrimary: false,
    }));

    const updatedExisting: MediaEntry[] = newPrimary
      ? existing.map((e) => ({ ...e, isPrimary: false }))
      : existing;

    const finalMedia = [
      ...updatedExisting,
      ...(newPrimary ? [newPrimary] : []),
      ...newOthers,
    ];

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).setMedia(row.id, finalMedia);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: productPublicId,
        action: AUDIT.imagesConfirmed,
        after: { added: allNew.map((i) => i.s3Key), totalMedia: finalMedia.length },
        requestId,
      });
    });

    logger.info({ productPublicId, added: allNew.length }, 'product.images_confirmed');
    return this.get(productPublicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async reorderImages(
    productPublicId: string,
    s3Keys: string[],
    actor: ProductActor,
    requestId: string,
  ): Promise<ProductView> {
    const row = await this.repo.findProductMedia(productPublicId, actor.tenantId);
    if (!row) throw new ProductNotFoundError('Product not found');

    const existing: MediaEntry[] = Array.isArray(row.media) ? (row.media as unknown as MediaEntry[]) : [];

    if (s3Keys.length !== existing.length) {
      throw new ProductImageReorderMismatchError(
        `Reorder list must include all ${existing.length} existing image(s); got ${s3Keys.length}`,
      );
    }

    const byKey = new Map(existing.map((e) => [e.s3Key, e]));
    for (const key of s3Keys) {
      if (!byKey.has(key)) {
        throw new ProductImageReorderMismatchError(`s3Key not found in product media: ${key}`);
      }
    }

    const reordered: MediaEntry[] = s3Keys.map((key, idx) => ({
      ...byKey.get(key)!,
      sortOrder: idx,
    }));

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).setMedia(row.id, reordered);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: productPublicId,
        action: AUDIT.imagesReordered,
        after: { order: s3Keys },
        requestId,
      });
    });

    logger.info({ productPublicId }, 'product.images_reordered');
    return this.get(productPublicId, actor.tenantId, actor.role === 'ADMIN');
  }

  async setPrimaryImage(
    productPublicId: string,
    s3Key: string,
    actor: ProductActor,
    requestId: string,
  ): Promise<ProductView> {
    const row = await this.repo.findProductMedia(productPublicId, actor.tenantId);
    if (!row) throw new ProductNotFoundError('Product not found');

    const existing: MediaEntry[] = Array.isArray(row.media) ? (row.media as unknown as MediaEntry[]) : [];

    const target = existing.find((e) => e.s3Key === s3Key);
    if (!target) throw new ProductImageNotFoundError('s3Key not found in product media');

    if (target.isPrimary) {
      return this.get(productPublicId, actor.tenantId, actor.role === 'ADMIN');
    }

    const updated = existing.map((e) => ({ ...e, isPrimary: e.s3Key === s3Key }));

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).setMedia(row.id, updated);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Product',
        entityId: productPublicId,
        action: AUDIT.imagePrimarySet,
        after: { s3Key },
        requestId,
      });
    });

    logger.info({ productPublicId, s3Key }, 'product.image_primary_set');
    return this.get(productPublicId, actor.tenantId, actor.role === 'ADMIN');
  }
}
