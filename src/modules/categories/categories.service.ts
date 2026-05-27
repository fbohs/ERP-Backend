import { logger } from '../../shared/logging/index.js';
import {
  CategoryNotFoundError,
  CategorySlugExistsError,
  CategoryHasProductsError,
  CircularCategoryReferenceError,
} from './categories.errors.js';
import type { CreateCategoryBody, UpdateCategoryBody } from './categories.schemas.js';
import type { CategoriesRepository } from './categories.repository.js';
import type { AuditRepository } from '../../shared/audit/index.js';
import type { AppDb } from '../../shared/db/index.js';
import type { CategoryView, CategoryActor } from './categories.types.js';

const AUDIT = {
  created: 'category.created',
  updated: 'category.updated',
  deactivated: 'category.deactivated',
} as const;

type CatRow = Awaited<ReturnType<CategoriesRepository['listByTenant']>>[number];

function toView(row: CatRow, parentPublicId: string | null): CategoryView {
  return {
    id: row.publicId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    parentId: parentPublicId,
    isActive: row.isActive,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

// Builds a map of internalId → direct children from a flat category list.
function buildChildrenMap(rows: CatRow[]): Map<string, CatRow[]> {
  const map = new Map<string, CatRow[]>();
  for (const row of rows) {
    if (row.parentId !== null) {
      const children = map.get(row.parentId) ?? [];
      children.push(row);
      map.set(row.parentId, children);
    }
  }
  return map;
}

// Collects all descendant internal IDs of a given node (BFS, not including the node itself).
function collectDescendantIds(id: string, childrenMap: Map<string, CatRow[]>): Set<string> {
  const ids = new Set<string>();
  const queue = [...(childrenMap.get(id) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift()!;
    ids.add(node.id);
    queue.push(...(childrenMap.get(node.id) ?? []));
  }
  return ids;
}

export class CategoriesService {
  constructor(
    private readonly repo: CategoriesRepository,
    private readonly audit: AuditRepository,
    private readonly db: AppDb,
  ) {}

  async create(input: CreateCategoryBody, actor: CategoryActor, requestId: string): Promise<CategoryView> {
    const slugConflict = await this.repo.findBySlug(input.slug, actor.tenantId);
    if (slugConflict) throw new CategorySlugExistsError(`Slug '${input.slug}' is already in use`);

    let parentInternalId: string | null = null;
    if (input.parentId) {
      const parent = await this.repo.findByPublicId(input.parentId, actor.tenantId);
      if (!parent) throw new CategoryNotFoundError('Parent category not found');
      parentInternalId = parent.id;
    }

    let createdPublicId!: string;

    await this.db.transaction().execute(async (tx) => {
      const txRepo = this.repo.withTx(tx);
      const row = await txRepo.insert({
        tenantId: actor.tenantId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        parentId: parentInternalId,
      });
      createdPublicId = row.publicId;
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Category',
        entityId: row.publicId,
        action: AUDIT.created,
        after: { name: input.name, slug: input.slug, parentId: input.parentId ?? null },
        requestId,
      });
    });

    logger.info({ id: createdPublicId }, 'category.created');
    return this.get(createdPublicId, actor.tenantId, true);
  }

  async list(tenantId: string, isAdmin: boolean): Promise<CategoryView[]> {
    const rows = await this.repo.listByTenant(tenantId);
    const idToPublicId = new Map(rows.map((r) => [r.id, r.publicId]));
    const visible = isAdmin ? rows : rows.filter((r) => r.isActive);
    return visible.map((r) =>
      toView(r, r.parentId !== null ? (idToPublicId.get(r.parentId) ?? null) : null),
    );
  }

  async get(publicId: string, tenantId: string, isAdmin: boolean): Promise<CategoryView> {
    const row = await this.repo.findByPublicId(publicId, tenantId);
    if (!row || (!isAdmin && !row.isActive)) throw new CategoryNotFoundError('Category not found');

    let parentPublicId: string | null = null;
    if (row.parentId !== null) {
      const parent = await this.repo.findPublicIdById(row.parentId, tenantId);
      parentPublicId = parent?.publicId ?? null;
    }

    return toView(row, parentPublicId);
  }

  async getChildren(publicId: string, tenantId: string, isAdmin: boolean): Promise<CategoryView[]> {
    const all = await this.repo.listByTenant(tenantId);
    const publicIdToRow = new Map(all.map((r) => [r.publicId, r]));
    const idToPublicId = new Map(all.map((r) => [r.id, r.publicId]));
    const childrenMap = buildChildrenMap(all);

    const root = publicIdToRow.get(publicId);
    if (!root || (!isAdmin && !root.isActive)) throw new CategoryNotFoundError('Category not found');

    const result: CategoryView[] = [];
    const queue = [...(childrenMap.get(root.id) ?? [])];

    while (queue.length > 0) {
      const node = queue.shift()!;
      // Non-admin: prune at inactive nodes — skip this node and do not traverse its children.
      if (!isAdmin && !node.isActive) continue;
      result.push(toView(node, node.parentId !== null ? (idToPublicId.get(node.parentId) ?? null) : null));
      queue.push(...(childrenMap.get(node.id) ?? []));
    }

    return result;
  }

  async update(
    publicId: string,
    input: UpdateCategoryBody,
    actor: CategoryActor,
    requestId: string,
  ): Promise<CategoryView> {
    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new CategoryNotFoundError('Category not found');

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const conflict = await this.repo.findBySlug(input.slug, actor.tenantId, publicId);
      if (conflict) throw new CategorySlugExistsError(`Slug '${input.slug}' is already in use`);
    }

    const patch: {
      name?: string;
      slug?: string;
      description?: string | null;
      parentId?: string | null;
      isActive?: boolean;
    } = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.description !== undefined) patch.description = input.description;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (input.parentId !== undefined) {
      if (input.parentId === null) {
        // Explicitly removing parent — make it a root category.
        patch.parentId = null;
      } else {
        if (input.parentId === publicId) {
          throw new CircularCategoryReferenceError('A category cannot be its own parent');
        }
        // Circular reference check: new parent must not be a descendant of this category.
        const all = await this.repo.listByTenant(actor.tenantId);
        const childrenMap = buildChildrenMap(all);
        const descendants = collectDescendantIds(existing.id, childrenMap);

        const newParent = all.find((r) => r.publicId === input.parentId);
        if (!newParent) throw new CategoryNotFoundError('Parent category not found');
        if (descendants.has(newParent.id)) {
          throw new CircularCategoryReferenceError(
            'Cannot move a category under one of its own descendants',
          );
        }
        patch.parentId = newParent.id;
      }
    }

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).update(existing.id, patch);
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Category',
        entityId: publicId,
        action: AUDIT.updated,
        before: { name: existing.name, slug: existing.slug },
        after: input,
        requestId,
      });
    });

    logger.info({ publicId }, 'category.updated');
    return this.get(publicId, actor.tenantId, true);
  }

  async deactivate(publicId: string, actor: CategoryActor, requestId: string): Promise<void> {
    const existing = await this.repo.findByPublicId(publicId, actor.tenantId);
    if (!existing) throw new CategoryNotFoundError('Category not found');

    if (await this.repo.hasLiveProducts(existing.id)) {
      throw new CategoryHasProductsError(
        'Cannot deactivate a category that has active products. Archive or reassign products first.',
      );
    }

    await this.db.transaction().execute(async (tx) => {
      await this.repo.withTx(tx).update(existing.id, { isActive: false });
      await this.audit.withTx(tx).record({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        entityType: 'Category',
        entityId: publicId,
        action: AUDIT.deactivated,
        before: { isActive: true },
        after: { isActive: false },
        requestId,
      });
    });

    logger.info({ publicId }, 'category.deactivated');
  }
}
