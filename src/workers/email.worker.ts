import { Worker } from 'bullmq';
import { createResend } from '../shared/email/resend.js';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  type PasswordResetEmailPayload,
} from '../modules/auth/jobs/send-password-reset-email.js';
import {
  PLATFORM_LOGIN_EMAIL_QUEUE,
  type PlatformLoginEmailPayload,
} from '../modules/platform/jobs/send-login-link-email.js';
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

export function createEmailWorkers(queueRedisUrl: string, resend: Resend): Worker[] {
  const connection = connectionFor(queueRedisUrl);

  const passwordResetWorker = new Worker<PasswordResetEmailPayload>(
    PASSWORD_RESET_EMAIL_QUEUE,
    async (job) => {
      const { email, name, resetUrl } = job.data;

      const result = await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: email,
        subject: 'Reset your password',
        html: `
          <p>Hi ${name},</p>
          <p>Click the link below to reset your password. It expires in 30 minutes.</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>If you did not request this, ignore this email.</p>
        `,
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
        from: 'onboarding@resend.dev',
        to: email,
        subject: 'Your admin login link',
        html: `
          <p>Hi ${name},</p>
          <p>Click the link below to sign in to the platform console. It expires in 15 minutes.</p>
          <p><a href="${loginUrl}">${loginUrl}</a></p>
          <p>If you did not request this, ignore this email.</p>
        `,
      });

      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
    },
    { connection, concurrency: 5 },
  );

  return [passwordResetWorker, platformLoginWorker];
}

export function startEmailWorkers(queueRedisUrl: string, apiKey: string): Worker[] {
  const resend = createResend(apiKey);
  return createEmailWorkers(queueRedisUrl, resend);
}
