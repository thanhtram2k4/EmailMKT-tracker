/**
 * Adding a suppression (the only direction: suppressions are append-only and never lifted by
 * automation). Used by one-click unsubscribe, SES hard bounces and complaints, and the admin
 * "Suppress address" form. A new suppression also:
 *  - records marketing consent as withdrawn (unsubscribe link / complaint);
 *  - queues the Notion "Subscription status" write-back for every contact with that address.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, suppressions } from "../db/schema";
import { appendConsent } from "../crm/consent";
import { labelForSuppression } from "../crm/mapping";
import { enqueueSubscriptionWrite } from "../crm/outbox";

type Reason = (typeof suppressions.$inferInsert)["reason"];
type Tx = Pick<Db, "insert" | "select" | "execute">;

export type SuppressInput = {
  email: string;
  reason: Reason;
  source: string;
  createdBy: string;
  campaignId?: string | null;
  contactId?: string | null;
  note?: string | null;
  /** Record marketing consent as withdrawn (unsubscribe link or complaint). */
  withdrawConsent?: { source: "unsubscribe_link" | "system"; evidenceNote: string; correlationId?: string | null };
};

export async function suppressAddress(tx: Tx, i: SuppressInput): Promise<{ added: boolean }> {
  const email = i.email.trim().toLowerCase();
  const inserted = await tx
    .insert(suppressions)
    .values({ emailNormalized: email, reason: i.reason, source: i.source, createdBy: i.createdBy, campaignId: i.campaignId ?? null, contactId: i.contactId ?? null, note: i.note ?? null })
    .onConflictDoNothing({ target: suppressions.emailNormalized })
    .returning({ e: suppressions.emailNormalized });

  if (i.withdrawConsent) {
    const cur = (
      await tx.execute(sql`select status::text as s from consent_records where email_normalized = ${email} and purpose = 'marketing_email' order by id desc limit 1`)
    ).rows[0] as { s: string } | undefined;
    if (cur?.s !== "withdrawn") {
      await appendConsent(tx, {
        emailNormalized: email,
        contactId: i.contactId ?? null,
        purpose: "marketing_email",
        status: "withdrawn",
        source: i.withdrawConsent.source,
        effectiveAt: new Date(),
        recordedBy: i.createdBy,
        evidenceNote: i.withdrawConsent.evidenceNote,
        correlationId: i.withdrawConsent.correlationId ?? null,
      });
    }
  }

  if (inserted.length) {
    const pages = await tx
      .select({ page: contacts.notionPageId })
      .from(contacts)
      .where(and(eq(contacts.emailNormalized, email), eq(contacts.state, "active")));
    for (const p of pages) {
      await enqueueSubscriptionWrite(tx, { notionPageId: p.page, label: labelForSuppression(i.reason), reason: `suppressed (${i.reason}) by ${i.source}` });
    }
  }
  return { added: inserted.length > 0 };
}
