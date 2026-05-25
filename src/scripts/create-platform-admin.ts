import { PlatformAuditRepository } from '../shared/audit/index.js';
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
 * endpoint. The creation is recorded in PlatformAuditLog in the same
 * transaction. See ADR 0002.
 */
export async function createPlatformAdmin(
  db: AppDb,
  input: { email: string; name: string },
): Promise<CreatePlatformAdminResult> {
  const email = input.email.trim();
  const name = input.name.trim();

  const existing = await db
    .selectFrom('PlatformAdmin')
    .select(['publicId', 'email'])
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing !== undefined) {
    return { status: 'exists', publicId: existing.publicId, email: existing.email };
  }

  return db.transaction().execute(async (tx) => {
    const created = await tx
      .insertInto('PlatformAdmin')
      .values({ email, name })
      .returning(['id', 'publicId', 'email'])
      .executeTakeFirstOrThrow();

    await new PlatformAuditRepository(tx).record({
      adminId: created.id,
      action: 'platform.admin_created',
      targetType: 'PlatformAdmin',
      targetId: created.publicId,
      after: { email: created.email, name },
    });

    return { status: 'created', publicId: created.publicId, email: created.email };
  });
}
