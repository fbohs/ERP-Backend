import type { UserRole } from '../../types/db.js';

export interface CachedSession {
  userId: string;
  tenantId: string;
  role: UserRole;
}

export function sessionCacheKey(token: string): string {
  return `session:${token}`;
}
