import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { Queue } from 'bullmq';
import type { FastifyPluginAsync } from 'fastify';
import { PASSWORD_RESET_EMAIL_QUEUE } from '../../modules/auth/jobs/send-password-reset-email.js';
import { PLATFORM_LOGIN_EMAIL_QUEUE } from '../../modules/platform/jobs/send-login-link-email.js';
import { createIpAllowlist } from '../auth/index.js';
import { NotFoundError } from '../errors/base.js';
import { connectionFor } from './connection.js';

interface BullBoardPluginOptions {
  queueRedisUrl: string;
  ipAllowlist: string;
}

export const bullBoardPlugin: FastifyPluginAsync<BullBoardPluginOptions> = async (app, opts) => {
  const allowlist = createIpAllowlist(opts.ipAllowlist);

  app.addHook('onRequest', async (request) => {
    if (!allowlist.allows(request.ip)) {
      throw new NotFoundError('Not found');
    }
  });

  const connection = connectionFor(opts.queueRedisUrl);
  const queues = [
    new Queue(PASSWORD_RESET_EMAIL_QUEUE, { connection }),
    new Queue(PLATFORM_LOGIN_EMAIL_QUEUE, { connection }),
  ];

  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({ queues: queues.map((q) => new BullMQAdapter(q)), serverAdapter });

  await app.register(serverAdapter.registerPlugin(), { prefix: '/admin/queues' });

  app.addHook('onClose', async () => {
    await Promise.all(queues.map((q) => q.close()));
  });
};
