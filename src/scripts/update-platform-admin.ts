import { PlatformAuditRepository } from '@/shared/audit/index.js';
import type { AppDb } from '@/shared/db/index.js';

export interface UpdatePlatformAdminInput {
  email: string;
  name?: string;
  isActive?: boolean;
}

export interface UpdatePlatformAdminResult {
  status: 'updated' | 'not_found';
  email: string;
  publicId?: string;
}

/**
 * Updates a platform admin's name and/or active flag, looked up by email. At
 * least one of name/isActive must be supplied (the CLI enforces this). Deactivating
 * (isActive=false) blocks future logins and fails the authenticate check, but does
 * not by itself drop live sessions — pair with revokePlatformAdminSessions to kick
 * an active operator. The change is recorded in PlatformAuditLog in the same
 * transaction. See ADR 0002.
 */
export async function updatePlatformAdmin(
  db: AppDb,
  input: UpdatePlatformAdminInput,
): Promise<UpdatePlatformAdminResult> {
  const email = input.email.trim();

  const admin = await db
    .selectFrom('PlatformAdmin')
    .select(['id', 'publicId', 'email', 'name', 'isActive'])
    .where('email', '=', email)
    .executeTakeFirst();

  if (admin === undefined) {
    return { status: 'not_found', email };
  }

  const next = {
    name: input.name !== undefined ? input.name.trim() : admin.name,
    isActive: input.isActive !== undefined ? input.isActive : admin.isActive,
  };

  return db.transaction().execute(async (tx) => {
    await tx
      .updateTable('PlatformAdmin')
      .set({ name: next.name, isActive: next.isActive, updatedAt: new Date() })
      .where('id', '=', admin.id)
      .execute();

    await new PlatformAuditRepository(tx).record({
      adminId: admin.id,
      action: 'platform.admin_updated',
      targetType: 'PlatformAdmin',
      targetId: admin.publicId,
      before: { name: admin.name, isActive: admin.isActive },
      after: { name: next.name, isActive: next.isActive },
    });

    return { status: 'updated', email: admin.email, publicId: admin.publicId };
  });
}
