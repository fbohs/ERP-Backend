import type { Transaction } from 'kysely';
import type { AppDb } from '@/shared/db/index.js';
import type { DB, Actortype, Json } from '@/types/db.js';

type Executor = AppDb | Transaction<DB>;

export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  // Which id-space actorId belongs to. Defaults to USER (tenant user) when
  // omitted; platform actions pass PLATFORM_ADMIN. See ADR 0002.
  actorType?: Actortype;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/**
 * Writes to the append-only audit ledger. Construct with a transaction via
 * `withTx` so the audit row commits in lockstep with the operation it records
 * (charter §8 / hard rule #7).
 */
export class AuditRepository {
  constructor(private readonly exec: Executor) {}

  withTx(tx: Transaction<DB>): AuditRepository {
    return new AuditRepository(tx);
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.exec
      .insertInto('AuditLog')
      .values({
        tenantId: entry.tenantId,
        actorId: entry.actorId,
        actorType: entry.actorType ?? 'USER',
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        before: (entry.before ?? null) as Json | null,
        after: (entry.after ?? null) as Json | null,
        requestId: entry.requestId ?? null,
      })
      .execute();
  }
}
