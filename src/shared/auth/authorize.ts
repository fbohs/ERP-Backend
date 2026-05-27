import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '../errors/base.js';
import { ROLE_PERMISSIONS, type Permission } from './permissions.js';

export function authorize(...required: Permission[]) {
  return async function (request: FastifyRequest): Promise<void> {
    const perms = ROLE_PERMISSIONS[request.user.role];
    if (!required.every((p) => perms.has(p))) {
      throw new ForbiddenError('Insufficient permissions');
    }
  };
}
