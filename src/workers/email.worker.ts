import { Worker } from 'bullmq';
import { createResend } from '../shared/email/resend.js';
import { passwordResetEmail, platformLoginEmail, tenantWelcomeEmail, userWelcomeEmail } from '../shared/email/templates.js';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  type PasswordResetEmailPayload,
} from '../modules/auth/jobs/send-password-reset-email.js';
import {
  PLATFORM_LOGIN_EMAIL_QUEUE,
  type PlatformLoginEmailPayload,
} from '../modules/platform/jobs/send-login-link-email.js';
import {
  TENANT_WELCOME_EMAIL_QUEUE,
  type TenantWelcomeEmailPayload,
} from '../modules/platform/jobs/send-tenant-welcome-email.js';
import {
  USER_WELCOME_EMAIL_QUEUE,
  type UserWelcomeEmailPayload,
} from '../modules/users/jobs/send-user-welcome-email.js';
import type { Resend } from '../shared/email/resend.js';

function connectionFor(queueRedisUrl: string) {
  const url = new URL(queueRedisUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    ...(url.password ? { password: url.password } : {}),
    ...(url.username ? { username: url.username } : {}),
  };
}

interface EmailWorkerOptions {
  emailFrom: string;
  passwordResetTtlMinutes: number;
  platformLoginTtlMinutes: number;
  appBaseUrl: string;
}

export function createEmailWorkers(queueRedisUrl: string, resend: Resend, opts: EmailWorkerOptions): Worker[] {
  const connection = connectionFor(queueRedisUrl);

  const passwordResetWorker = new Worker<PasswordResetEmailPayload>(
    PASSWORD_RESET_EMAIL_QUEUE,
    async (job) => {
      const { email, name, resetUrl } = job.data;

      const result = await resend.emails.send({
        from: opts.emailFrom,
        to: email,
        subject: 'Reset your password',
        html: passwordResetEmail({ name, resetUrl, ttlMinutes: opts.passwordResetTtlMinutes }),
      });

      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
    },
    { connection, concurrency: 5 },
  );

  const platformLoginWorker = new Worker<PlatformLoginEmailPayload>(
    PLATFORM_LOGIN_EMAIL_QUEUE,
    async (job) => {
      const { email, name, loginUrl } = job.data;

      const result = await resend.emails.send({
        from: opts.emailFrom,
        to: email,
        subject: 'Your sign-in link for Platform Console',
        html: platformLoginEmail({ name, loginUrl, ttlMinutes: opts.platformLoginTtlMinutes }),
      });

      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
    },
    { connection, concurrency: 5 },
  );

  const tenantWelcomeWorker = new Worker<TenantWelcomeEmailPayload>(
    TENANT_WELCOME_EMAIL_QUEUE,
    async (job) => {
      const { email, name, tenantName, temporaryPassword, loginUrl } = job.data;

      const result = await resend.emails.send({
        from: opts.emailFrom,
        to: email,
        subject: `Welcome to ${tenantName} — your account is ready`,
        html: tenantWelcomeEmail({ name, tenantName, email, temporaryPassword, loginUrl }),
      });

      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
    },
    { connection, concurrency: 5 },
  );

  const userWelcomeWorker = new Worker<UserWelcomeEmailPayload>(
    USER_WELCOME_EMAIL_QUEUE,
    async (job) => {
      const { email, name, role, tenantName, temporaryPassword, loginUrl } = job.data;

      const result = await resend.emails.send({
        from: opts.emailFrom,
        to: email,
        subject: `Welcome to ${tenantName} — your account is ready`,
        html: userWelcomeEmail({ name, role, tenantName, email, temporaryPassword, loginUrl }),
      });

      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
    },
    { connection, concurrency: 5 },
  );

  return [passwordResetWorker, platformLoginWorker, tenantWelcomeWorker, userWelcomeWorker];
}

export function startEmailWorkers(queueRedisUrl: string, apiKey: string, opts: EmailWorkerOptions): Worker[] {
  const resend = createResend(apiKey);
  return createEmailWorkers(queueRedisUrl, resend, opts);
}
