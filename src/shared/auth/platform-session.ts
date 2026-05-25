// The platform principal attached to a request by the authenticatePlatform
// preHandler. Platform auth is DB-only (no session cache), so there is no
// cached-session shape here — just the resolved identity. See ADR 0002.
export interface PlatformPrincipal {
  adminId: string;
}
