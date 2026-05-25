import type { AppDb } from '../shared/db/index.js';

export interface CreatePlatformAdminResult {
  status: 'created' | 'exists';
  publicId: string;
  email: string;
}

/**
 * Idempotently provisions a platform admin (superadmin) by email. No password
 * is stored — the admin authenticates via the emailed magic-link flow. Run as a
 * release step to bootstrap the first operator; there is no self-registration
 * endpoint. See ADR 0002.
 */
export async function createPlatformAdmin(
  db: AppDb,
  input: { email: string; name: string },
): Promise<CreatePlatformAdminResult> {
  const email = input.email.trim();

  const existing = await db
    .selectFrom('PlatformAdmin')
    .select(['publicId', 'email'])
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing !== undefined) {
    return { status: 'exists', publicId: existing.publicId, email: existing.email };
  }

  const created = await db
    .insertInto('PlatformAdmin')
    .values({ email, name: input.name.trim() })
    .returning(['publicId', 'email'])
    .executeTakeFirstOrThrow();

  return { status: 'created', publicId: created.publicId, email: created.email };
}
