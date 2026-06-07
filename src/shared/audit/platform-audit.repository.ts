import type { Transaction } from 'kysely';
import type { AppDb } from '@/shared/db/index.js';
import type { DB, Json } from '@/types/db.js';

type Executor = AppDb | Transaction<DB>;

export interface PlatformAuditEntry {
  // Internal PlatformAdmin id (bigint as string), or null for CLI/system actions
  // with no live admin principal.
  adminId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  requestId?: string | null;
}

/**
 * Append-only ledger for platform-GLOBAL operator actions that have no tenant —
 * login, logout, session termination, admin lifecycle. Tenant-scoped platform
 * actions (tenant created/suspended) still write to the tenant AuditLog with
 * actorType=PLATFORM_ADMIN. Construct with `withTx` so the audit row commits in
 * lockstep with the operation it records (charter §8). See ADR 0002.
 */
export class PlatformAuditRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): PlatformAuditRepository {
    return new PlatformAuditRepository(tx);
  }

  async record(entry: PlatformAuditEntry): Promise<void> {
    await this.exec
      .insertInto('PlatformAuditLog')
      .values({
        adminId: entry.adminId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        before: (entry.before ?? null) as Json | null,
        after: (entry.after ?? null) as Json | null,
        ipAddress: entry.ipAddress ?? null,
        requestId: entry.requestId ?? null,
      })
      .execute();
  }
}
