import { Worker } from 'bullmq';
import { createResend } from '../shared/email/resend.js';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  type PasswordResetEmailPayload,
} from '../modules/auth/jobs/send-password-reset-email.js';
import type { Resend } from '../shared/email/resend.js';

export function createEmailWorker(queueRedisUrl: string, resend: Resend): Worker {
  const url = new URL(queueRedisUrl);

  const worker = new Worker<PasswordResetEmailPayload>(
    PASSWORD_RESET_EMAIL_QUEUE,
    async (job) => {
      const { email, name, resetUrl } = job.data;

      const result = await resend.emails.send({
        from: 'no-reply@yourdomain.com',
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
    {
      connection: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        ...(url.password ? { password: url.password } : {}),
        ...(url.username ? { username: url.username } : {}),
      },
      concurrency: 5,
    },
  );

  return worker;
}

export function startEmailWorker(queueRedisUrl: string, apiKey: string): Worker {
  const resend = createResend(apiKey);
  return createEmailWorker(queueRedisUrl, resend);
}
