import type { FastifyInstance } from 'fastify';
import { AppError } from './base.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    // Fastify schema validation errors (from JSON schema on routes) carry a
    // `validation` array. Map header validation to 401, everything else to 422.
    const err = error as { validation?: unknown; validationContext?: string; message?: string };
    if (err.validation !== undefined) {
      const statusCode = err.validationContext === 'headers' ? 401 : 422;
      const code = err.validationContext === 'headers' ? 'UNAUTHORIZED' : 'VALIDATION_ERROR';
      return reply.status(statusCode).send({
        error: { code, message: err.message ?? 'Validation error' },
      });
    }

    app.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
}
