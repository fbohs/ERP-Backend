import { PlatformAuditRepository } from '../shared/audit/index.js';
import type { AppDb } from '../shared/db/index.js';

export interface RevokePlatformAdminSessionsResult {
  status: 'revoked' | 'not_found';
  email: string;
  revokedCount: number;
}

/**
 * Terminates ALL live sessions for a platform admin, looked up by email — the
 * break-glass response to a leaked or suspected-compromised session token. Because
 * platform auth is DB-only (no session cache), deleting the rows takes effect on
 * the admin's very next request. Recorded in PlatformAuditLog in the same
 * transaction. See ADR 0002.
 */
export async function revokePlatformAdminSessions(
  db: AppDb,
  input: { email: string },
): Promise<RevokePlatformAdminSessionsResult> {
  const email = input.email.trim();

  const admin = await db
    .selectFrom('PlatformAdmin')
    .select(['id', 'publicId'])
    .where('email', '=', email)
    .executeTakeFirst();

  if (admin === undefined) {
    return { status: 'not_found', email, revokedCount: 0 };
  }

  return db.transaction().execute(async (tx) => {
    const result = await tx
      .deleteFrom('PlatformAdminSession')
      .where('adminId', '=', admin.id)
      .executeTakeFirst();
    const revokedCount = Number(result.numDeletedRows);

    await new PlatformAuditRepository(tx).record({
      adminId: admin.id,
      action: 'platform.sessions_revoked',
      targetType: 'PlatformAdminSession',
      targetId: admin.publicId,
      after: { revokedCount },
    });

    return { status: 'revoked', email, revokedCount };
  });
}
