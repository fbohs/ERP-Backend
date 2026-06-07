# Runbook: Rotate API Keys

> Covers Resend API key, AWS credentials, and platform admin session revocation.

---

## 1. Resend API Key (`RESEND_API_KEY`)

**When:** Key leaked, team member offboarded, or routine rotation policy.

**Steps:**

1. Log in to the Resend dashboard and generate a new API key scoped to the same verified sending domain.
2. Update `RESEND_API_KEY` on the deployment platform (no code change needed).
3. Restart the application — the Resend client is constructed at startup from config.
4. **Verify:** Trigger a password reset for a test account and confirm the email arrives. Check the Resend dashboard for a successful delivery event.
5. Revoke the old key in the Resend dashboard once the new process is confirmed healthy.

> **Watch out:** `EMAIL_FROM` must match the domain scope of the new key. Key rotation is the most common moment to introduce a domain mismatch — Resend will silently accept the send but not deliver it. See `docs/known-issues.md`.

---

## 2. AWS Credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)

**When:** Credentials leaked, IAM user offboarded, or routine rotation.

**Steps:**

1. In AWS IAM, create a **new** access key for the service user (do not rotate the root key).
2. Update `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` on the deployment platform.
3. Restart the application.
4. **Verify:** Generate a presigned URL via the API and confirm an upload or download succeeds end-to-end.
5. In IAM, deactivate the old key, wait 24 hours to confirm nothing breaks, then delete it.

---

## 3. Platform Admin Sessions

Platform admin sessions are DB-backed with no Redis cache layer — revoking a row takes effect immediately.

**Revoke all active sessions for an admin (forces re-authentication):**

```bash
DATABASE_URL=<prod-url> pnpm platform:revoke-sessions -- --email admin@example.com
```

Expected output:
```
{"email":"admin@example.com","revokedCount":1,"msg":"Platform admin sessions revoked"}
```

The admin must re-authenticate via the magic-link flow. Their next login generates a fresh session token.

**When to use this:**
- Suspected session compromise.
- Admin machine lost or stolen.
- Offboarding a platform admin (run this before or after deactivating the account).
