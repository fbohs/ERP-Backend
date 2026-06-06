import { Client } from 'pg';
import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../logging/index.js';

const PROBE_TIMEOUT_MS = 5_000;

async function probePostgres(): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  });
  await client.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

async function probeRedis(url: string): Promise<void> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  await redis.connect();
  try {
    await redis.ping();
  } finally {
    await redis.quit();
  }
}

export async function assertInfraReady(): Promise<void> {
  const probes: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'PostgreSQL', fn: probePostgres },
    { name: 'Redis (session)', fn: () => probeRedis(config.redisUrl) },
    { name: 'Redis (queue)', fn: () => probeRedis(config.queueRedisUrl) },
  ];

  const results = await Promise.allSettled(probes.map((p) => p.fn()));

  let failed = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const name = probes[i]!.name;
    if (result.status === 'fulfilled') {
      logger.info(`${name}: ready`);
    } else {
      logger.error({ err: result.reason }, `${name}: not reachable`);
      failed = true;
    }
  }

  if (failed) {
    logger.error('Infrastructure check failed — aborting startup');
    process.exit(1);
  }
}
