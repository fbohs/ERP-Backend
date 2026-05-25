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
  // Whether to trust X-Forwarded-* (set true only behind a known proxy). The
  // /platform IP allowlist reads request.ip, so this must match the real
  // proxy topology or the allowlist guards the wrong address. See ADR 0002.
  trustProxy: process.env['TRUST_PROXY'] === 'true',
  // Comma-separated exact IPs and IPv4 CIDR ranges allowed to reach /platform.
  // Empty = fail-closed (deny all). See ADR 0002.
  platformIpAllowlist: process.env['PLATFORM_IP_ALLOWLIST'] ?? '',
  sessionTtlSeconds: 28_800,            // 8 hours, absolute expiry
  passwordResetTtlSeconds: 1_800,       // 30 minutes
  platformSessionTtlSeconds: 28_800,    // 8 hours, absolute expiry
  platformLoginTokenTtlSeconds: 900,    // 15 minutes — magic-link login
  get isProduction() {
    return this.nodeEnv === 'production';
  },
} as const;
