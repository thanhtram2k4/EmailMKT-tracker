import { and, eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { contacts, duplicateResolutions } from "../db/schema";

/** Admin decision: which page is the primary contact for a duplicate email. Never edits Notion. */
export async function choosePrimary(db: Db, i: { contactId: string; actor: string; note?: string; correlationId?: string }) {
  const c = (await db.select().from(contacts).where(eq(contacts.id, i.contactId)).limit(1))[0];
  if (!c || !c.emailNormalized || !c.isDuplicate || c.state !== "active") throw new Error("Contact is not an active duplicate");
  const before = (await db.select().from(duplicateResolutions).where(eq(duplicateResolutions.emailNormalized, c.emailNormalized)).limit(1))[0];
  const values = { primaryContactId: c.id, decidedBy: i.actor, decidedAt: new Date(), note: i.note ?? null };
  await db
    .insert(duplicateResolutions)
    .values({ emailNormalized: c.emailNormalized, ...values })
    .onConflictDoUpdate({ target: duplicateResolutions.emailNormalized, set: values });
  await writeAudit(db, {
    actor: i.actor,
    action: "crm.duplicate_primary_chosen",
    entityType: "contact",
    entityId: c.id,
    before: before ? { primaryContactId: before.primaryContactId } : null,
    after: { email: c.emailNormalized, primaryContactId: c.id },
    correlationId: i.correlationId,
  });
}

export async function clearPrimary(db: Db, i: { emailNormalized: string; actor: string; correlationId?: string }) {
  const r = await db.delete(duplicateResolutions).where(and(eq(duplicateResolutions.emailNormalized, i.emailNormalized))).returning();
  if (r.length) {
    await writeAudit(db, { actor: i.actor, action: "crm.duplicate_primary_cleared", entityType: "duplicate", entityId: i.emailNormalized, before: { primaryContactId: r[0].primaryContactId }, correlationId: i.correlationId });
  }
}
