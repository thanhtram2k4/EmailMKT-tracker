import type { Db } from "./db/client";
import { auditLog } from "./db/schema";

export type AuditEntry = {
  actor: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
};

/** Append an audit record. Application code never updates or deletes audit rows. */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    correlationId: e.correlationId,
  });
}
