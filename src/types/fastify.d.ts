import type { UserRole } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      tenantId: string;
      role: UserRole;
    };
    // Set by the authenticatePlatform preHandler on the /platform/* surface.
    // Separate from `user` — a platform admin is never a tenant principal.
    platformAdmin: {
      adminId: string;
    };
    // Set by the idempotency preHandler when a request claims a fresh key;
    // read by the onSend hook to store the response. Absent on replays.
    idempotencyKey?: string;
  }
}
