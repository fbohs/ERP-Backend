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
  queueRedisUrl: process.env['QUEUE_REDIS_URL'] ?? '',
  resendApiKey: process.env['RESEND_API_KEY'] ?? '',
  appBaseUrl: process.env['APP_BASE_URL'] ?? 'http://localhost:3000',
  sessionTtlSeconds: 28_800,         // 8 hours, absolute expiry
  passwordResetTtlSeconds: 1_800,    // 30 minutes
  get isProduction() {
    return this.nodeEnv === 'production';
  },
} as const;
