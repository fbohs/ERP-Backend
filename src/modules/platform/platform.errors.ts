import { AppError } from '@/shared/errors/base.js';

// The shared ConflictError/NotFoundError pin `code` to a literal, so domain
// subclasses extend AppError directly. The global handler maps any AppError by
// its statusCode + code.
export class TenantSlugTakenError extends AppError {
  readonly code = 'TENANT_SLUG_TAKEN';
  readonly statusCode = 409;
}

export class TenantNotFoundError extends AppError {
  readonly code = 'TENANT_NOT_FOUND';
  readonly statusCode = 404;
}
