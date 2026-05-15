import { Resend } from 'resend';

export type { Resend };

export function createResend(apiKey: string): Resend {
  return new Resend(apiKey);
}
