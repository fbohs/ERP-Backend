import type { Userrole } from '@/types/db.js';

export interface CachedSession {
  userId: string;
  tenantId: string;
  role: Userrole;
}

export function sessionCacheKey(token: string): string {
  return `session:${token}`;
}
