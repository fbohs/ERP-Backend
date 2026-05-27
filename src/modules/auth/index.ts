export { authPlugin } from './auth.routes.js';
// Published for tenant-onboarding reuse: the platform module issues a
// password-reset ("set your password") link when it provisions a tenant's
// first admin, reusing this queue and its worker. See ADR 0002.
export {
  createPasswordResetEmailQueue,
  enqueuePasswordResetEmail,
  type PasswordResetEmailQueue,
  type PasswordResetEmailPayload,
} from './jobs/send-password-reset-email.js';
