const rawPort = process.env['PORT'];
const rawHost = process.env['HOST'];
const rawNodeEnv = process.env['NODE_ENV'];
const rawLogLevel = process.env['LOG_LEVEL'];

export const config = {
  port: rawPort !== undefined ? Number(rawPort) : 3000,
  host: rawHost ?? '0.0.0.0',
  nodeEnv: rawNodeEnv ?? 'development',
  logLevel: rawLogLevel ?? 'info',
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  redisUrl: process.env['REDIS_URL'] ?? '',
  get isProduction() {
    return this.nodeEnv === 'production';
  },
} as const;
