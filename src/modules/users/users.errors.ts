import { AppError } from '@/shared/errors/base.js';

// Shared error classes pin `code` to a literal, so domain subclasses extend
// AppError directly and set statusCode explicitly.

export class UserNotFoundError extends AppError {
  readonly code = 'USER_NOT_FOUND';
  readonly statusCode = 404;
}

export class EmailAlreadyTakenError extends AppError {
  readonly code = 'EMAIL_ALREADY_TAKEN';
  readonly statusCode = 409;
}

export class CannotModifySelfError extends AppError {
  readonly code = 'CANNOT_MODIFY_SELF';
  readonly statusCode = 403;
}

export class ForbiddenRoleError extends AppError {
  readonly code = 'FORBIDDEN_ROLE';
  readonly statusCode = 403;
}
