export interface CachedPlatformSession {
  adminId: string;
}

export function platformSessionCacheKey(token: string): string {
  return `platform-session:${token}`;
}
