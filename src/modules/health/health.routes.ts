import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from './health.schemas.js';

export const healthPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: HealthResponse }>(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok'] },
              timestamp: { type: 'string', format: 'date-time' },
            },
            required: ['status', 'timestamp'],
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
    }),
  );
};
