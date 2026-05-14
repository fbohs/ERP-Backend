import type { UserRole } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      tenantId: string;
      role: UserRole;
    };
  }
}
