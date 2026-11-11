/**
 * Consent records (append-only). Rules:
 *  - No record ⇒ status "unknown". Imported contacts default to unknown.
 *  - Imports/sync can record "unknown" (with any evidence reference found in Notion) and
 *    "withdrawn" (a person set Unsubscribed in Notion) — never "granted".
 *  - "granted" can only come from an explicit staff entry with an evidence reference or note,
 *    and it never removes a suppression.
 * These rules are also enforced by DB CHECK constraints (drizzle/0003_crm_append_only_guards.sql).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { consentRecords, type consentPurpose, type consentSource, type consentStatus } from "../db/schema";

export type ConsentPurpose = (typeof consentPurpose.enumValues)[number];
export type ConsentStatus = (typeof consentStatus.enumValues)[number];
export type ConsentSource = (typeof consentSource.enumValues)[number];

export const CONSENT_PURPOSES: ConsentPurpose[] = ["marketing_email", "email_tracking"];

export class ConsentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentRuleError";
  }
}

const AUTOMATED_SOURCES: ConsentSource[] = ["notion_import", "notion_unsubscribe", "system"];

export type NewConsentRecord = {
  emailNormalized: string;
  contactId?: string | null;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  source: ConsentSource;
  effectiveAt?: Date | null;
  recordedBy: string;
  evidenceRef?: string | null;
  evidenceNote?: string | null;
  consentTextVersion?: string | null;
  correlationId?: string | null;
};

export function assertConsentAllowed(r: NewConsentRecord) {
  if (r.status === "granted" && AUTOMATED_SOURCES.includes(r.source)) {
    throw new ConsentRuleError("Consent cannot be granted by an import or sync; it requires an explicit staff entry with evidence.");
  }
  if (r.status === "granted" && !(r.evidenceRef?.trim() || r.evidenceNote?.trim())) {
    throw new ConsentRuleError("Recording granted consent requires an evidence reference or note.");
  }
}

/** Accepts a Db or a transaction handle. */
type DbLike = Pick<Db, "insert" | "select">;

export async function appendConsent(db: DbLike, r: NewConsentRecord) {
  assertConsentAllowed(r);
  const [row] = await db
    .insert(consentRecords)
    .values({
      emailNormalized: r.emailNormalized,
      contactId: r.contactId ?? null,
      purpose: r.purpose,
      status: r.status,
      source: r.source,
      effectiveAt: r.effectiveAt ?? null,
      recordedBy: r.recordedBy,
      evidenceRef: r.evidenceRef?.trim() || null,
      evidenceNote: r.evidenceNote?.trim() || null,
      consentTextVersion: r.consentTextVersion?.trim() || null,
      correlationId: r.correlationId ?? null,
    })
    .returning();
  return row;
}

export async function hasAnyConsentRecord(db: DbLike, emailNormalized: string, purpose: ConsentPurpose) {
  const r = await db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(and(eq(consentRecords.emailNormalized, emailNormalized), eq(consentRecords.purpose, purpose)))
    .limit(1);
  return r.length > 0;
}

export async function currentConsent(db: DbLike, emailNormalized: string): Promise<Record<ConsentPurpose, ConsentStatus>> {
  const out: Record<ConsentPurpose, ConsentStatus> = { marketing_email: "unknown", email_tracking: "unknown" };
  const rows = await db
    .select()
    .from(consentRecords)
    .where(eq(consentRecords.emailNormalized, emailNormalized))
    .orderBy(desc(consentRecords.id));
  for (const p of CONSENT_PURPOSES) out[p] = rows.find((r) => r.purpose === p)?.status ?? "unknown";
  return out;
}

export async function consentHistory(db: DbLike, emailNormalized: string) {
  return db.select().from(consentRecords).where(eq(consentRecords.emailNormalized, emailNormalized)).orderBy(desc(consentRecords.id));
}

/** SQL fragment: current marketing_email consent status for a contact row alias `c`. */
export const currentMarketingConsentSql = sql`coalesce((
  select cr.status::text from consent_records cr
  where cr.email_normalized = contacts.email_normalized and cr.purpose = 'marketing_email'
  order by cr.id desc limit 1), 'unknown')`;

/** Staff entry (explicit, audited). Does not touch suppressions. */
export async function recordConsentByStaff(db: Db, r: Omit<NewConsentRecord, "source"> & { actor: string }) {
  const row = await appendConsent(db, { ...r, source: "staff_entry", recordedBy: r.actor });
  await writeAudit(db, {
    actor: r.actor,
    action: "crm.consent_recorded",
    entityType: "contact",
    entityId: r.contactId ?? r.emailNormalized,
    after: { purpose: r.purpose, status: r.status, evidenceRef: row.evidenceRef, effectiveAt: row.effectiveAt },
    correlationId: r.correlationId ?? undefined,
  });
  return row;
}
