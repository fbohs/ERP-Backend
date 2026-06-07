import { NotFoundError, ConflictError } from '@/shared/errors/base.js';

export class CategoryNotFoundError extends NotFoundError {
  override readonly code = 'CATEGORY_NOT_FOUND';
}

export class CategorySlugExistsError extends ConflictError {
  override readonly code = 'CATEGORY_SLUG_EXISTS';
}

export class CategoryHasProductsError extends ConflictError {
  override readonly code = 'CATEGORY_HAS_PRODUCTS';
}

export class CircularCategoryReferenceError extends ConflictError {
  override readonly code = 'CIRCULAR_CATEGORY_REFERENCE';
}
