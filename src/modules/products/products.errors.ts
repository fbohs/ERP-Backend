import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/base.js';

export class ProductNotFoundError extends NotFoundError {
  override readonly code = 'PRODUCT_NOT_FOUND';
}

export class ProductSkuExistsError extends ConflictError {
  override readonly code = 'PRODUCT_SKU_EXISTS';
}

export class ProductSlugExistsError extends ConflictError {
  override readonly code = 'PRODUCT_SLUG_EXISTS';
}

export class VariantSkuExistsError extends ConflictError {
  override readonly code = 'VARIANT_SKU_EXISTS';
}

export class InvalidCategoryError extends ValidationError {
  override readonly code = 'INVALID_CATEGORY';
}

export class InvalidUomError extends ValidationError {
  override readonly code = 'INVALID_UOM';
}

export class ProductImageNotUploadedError extends ValidationError {
  override readonly code = 'PRODUCT_IMAGE_NOT_UPLOADED';
}

export class ProductImageTooLargeError extends ValidationError {
  override readonly code = 'PRODUCT_IMAGE_TOO_LARGE';
}

export class ProductImageKeyMismatchError extends ValidationError {
  override readonly code = 'PRODUCT_IMAGE_KEY_MISMATCH';
}
