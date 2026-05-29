export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  override readonly code: string = 'NOT_FOUND';
  readonly statusCode = 404;
}

export class ConflictError extends AppError {
  override readonly code: string = 'CONFLICT';
  readonly statusCode = 409;
}

export class ValidationError extends AppError {
  override readonly code: string = 'VALIDATION_ERROR';
  readonly statusCode = 422;
}

export class UnauthorizedError extends AppError {
  override readonly code: string = 'UNAUTHORIZED';
  readonly statusCode = 401;
}

export class ForbiddenError extends AppError {
  override readonly code: string = 'FORBIDDEN';
  readonly statusCode = 403;
}
