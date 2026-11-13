/**
 * Unsubscribe by opaque token (DESIGN §4.3):
 *  - GET  /u/{token}: a confirmation page only (security scanners follow links; they must not unsubscribe);
 *  - POST /u/{token}: unsubscribes (RFC 8058 one-click from the mail client, or the page's button).
 * Unsubscribing adds a suppression immediately (it is checked before every send, so queued
 * messages to that address are skipped), records consent as withdrawn and queues the Notion update.
 */
import { eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { Db } from "../db/client";
import { campaignRecipients, messageEvents, messages, suppressions } from "../db/schema";
import { maskEmail } from "../redact";
import { suppressAddress } from "./suppression";

export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function lookupToken(db: Db, token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const m = (await db.select().from(messages).where(eq(messages.trackingToken, token)).limit(1))[0];
  if (!m) return null;
  const s = (await db.select({ e: suppressions.emailNormalized }).from(suppressions).where(eq(suppressions.emailNormalized, m.emailNormalized)).limit(1))[0];
  return { message: m, maskedEmail: maskEmail(m.emailNormalized), alreadySuppressed: Boolean(s) };
}

export async function unsubscribeByToken(
  db: Db,
  token: string,
  o: { method: "one_click" | "confirm_page"; correlationId?: string; clock?: Clock },
): Promise<{ maskedEmail: string; added: boolean } | null> {
  const found = await lookupToken(db, token);
  if (!found) return null;
  const m = found.message;
  const now = (o.clock ?? systemClock).now();
  const added = await db.transaction(async (tx) => {
    const rec = (await tx.select({ contactId: campaignRecipients.contactId }).from(campaignRecipients).where(eq(campaignRecipients.id, m.recipientId)).limit(1))[0];
    const r = await suppressAddress(tx, {
      email: m.emailNormalized,
      reason: "unsubscribe",
      source: o.method === "one_click" ? "unsubscribe_one_click" : "unsubscribe_page",
      createdBy: "recipient",
      campaignId: m.campaignId,
      contactId: rec?.contactId ?? null,
      withdrawConsent: { source: "unsubscribe_link", evidenceNote: `Unsubscribed via ${o.method === "one_click" ? "one-click (List-Unsubscribe-Post)" : "the unsubscribe page"} at ${now.toISOString()}`, correlationId: o.correlationId },
    });
    await tx.insert(messageEvents).values({ messageId: m.id, campaignId: m.campaignId, type: "unsubscribe", occurredAt: now, receivedAt: now, detail: { method: o.method, newlySuppressed: r.added } });
    await writeAudit(tx as unknown as Db, {
      actor: "recipient",
      action: "suppression.unsubscribed",
      entityType: "campaign",
      entityId: m.campaignId,
      after: { recipient: maskEmail(m.emailNormalized), method: o.method, newlySuppressed: r.added, messageId: m.id },
      correlationId: o.correlationId,
    });
    return r.added;
  });
  return { maskedEmail: found.maskedEmail, added };
}
