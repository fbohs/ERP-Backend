import pino from 'pino';
import { config } from '@/shared/config/index.js';

export const logger = pino({
  level: config.logLevel,
  ...(config.isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});
