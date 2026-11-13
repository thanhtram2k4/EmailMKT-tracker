/**
 * SES event ingestion (configuration-set event publishing via SNS; DESIGN §4.1 step 7, §3.4).
 *  - Deduplicated on the SNS MessageId (message_events.provider_event_id is UNIQUE).
 *  - Matched to our message by the `msg_id` tag (campaign message or test send), else by the SES
 *    message id. Test-send events are stored with test_send_id and never touch campaign metrics.
 *  - Reconciliation: Send / Delivery / Bounce / Complaint / Reject / DeliveryDelay evidence turns an
 *    `unknown` (or staff-marked `marked_not_sent`) message into `sent`.
 *  - Delivery status only moves to a more significant state (complaint > hard bounce > …).
 *  - Hard bounces and complaints add a suppression (follows the address), queue the Notion
 *    write-back, and a complaint records consent as withdrawn.
 */
import { and, eq, inArray } from "drizzle-orm";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { Db } from "../db/client";
import { messageEvents, messages, testSends } from "../db/schema";
import { getLogger } from "../logger";
import { redactText } from "../redact";
import { loadCampaign, transition } from "./state";
import { suppressAddress } from "./suppression";

type EventType = (typeof messageEvents.$inferInsert)["type"];
type Delivery = (typeof messages.$inferSelect)["deliveryStatus"];

const RANK: Record<Delivery, number> = { none: 0, delayed: 1, delivered: 2, bounced_soft: 3, rejected: 3, bounced_hard: 4, complained: 5 };

type SesEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string; tags?: Record<string, string[]>; destination?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string; status?: string; action?: string }> };
  complaint?: { timestamp?: string; complaintFeedbackType?: string; complainedRecipients?: Array<{ emailAddress?: string }> };
  delivery?: { timestamp?: string; smtpResponse?: string };
  reject?: { reason?: string };
  deliveryDelay?: { timestamp?: string; delayType?: string };
  failure?: { errorMessage?: string };
};

export type IngestResult = { status: "processed" | "duplicate" | "ignored"; type?: EventType; matched: "campaign" | "test_send" | "none"; reconciled?: boolean; suppressed?: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classify(ev: SesEvent): { type: EventType; occurredAt: string | undefined; detail: Record<string, unknown>; delivery?: Delivery } | null {
  const kind = ev.eventType ?? ev.notificationType;
  switch (kind) {
    case "Send":
      return { type: "send", occurredAt: ev.mail?.timestamp, detail: {} };
    case "Delivery":
      return { type: "delivery", occurredAt: ev.delivery?.timestamp, detail: {}, delivery: "delivered" };
    case "Bounce": {
      const hard = ev.bounce?.bounceType === "Permanent";
      return {
        type: hard ? "bounce_hard" : "bounce_soft",
        occurredAt: ev.bounce?.timestamp,
        detail: {
          bounceType: ev.bounce?.bounceType ?? null,
          bounceSubType: ev.bounce?.bounceSubType ?? null,
          diagnostic: redactText((ev.bounce?.bouncedRecipients?.[0]?.diagnosticCode ?? "").slice(0, 300)) || null,
        },
        delivery: hard ? "bounced_hard" : "bounced_soft",
      };
    }
    case "Complaint":
      return { type: "complaint", occurredAt: ev.complaint?.timestamp, detail: { feedbackType: ev.complaint?.complaintFeedbackType ?? null }, delivery: "complained" };
    case "Reject":
      return { type: "reject", occurredAt: ev.mail?.timestamp, detail: { reason: ev.reject?.reason ?? null }, delivery: "rejected" };
    case "DeliveryDelay":
      return { type: "delay", occurredAt: ev.deliveryDelay?.timestamp, detail: { delayType: ev.deliveryDelay?.delayType ?? null }, delivery: "delayed" };
    case "Rendering Failure":
    case "RenderingFailure":
      return { type: "rendering_failure", occurredAt: ev.mail?.timestamp, detail: { error: redactText(ev.failure?.errorMessage ?? "").slice(0, 300) } };
    default:
      return null; // Open / Click / Subscription etc. are handled by our own tracking (M7) or ignored.
  }
}

export async function ingestSesEvent(db: Db, snsMessageId: string, raw: unknown, opts: { clock?: Clock; correlationId?: string } = {}): Promise<IngestResult> {
  const clock = opts.clock ?? systemClock;
  const log = getLogger().child({ task: "ses_event", sns_message_id: snsMessageId, request_id: opts.correlationId });
  const ev = (raw ?? {}) as SesEvent;
  const c = classify(ev);
  if (!c) {
    log.debug({ kind: ev.eventType ?? ev.notificationType }, "SES event type ignored");
    return { status: "ignored", matched: "none" };
  }
  const tag = (k: string) => ev.mail?.tags?.[k]?.[0];
  const msgTag = tag("msg_id");
  const purpose = tag("purpose");
  const providerMessageId = ev.mail?.messageId ?? null;

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // ---- match
    let message: typeof messages.$inferSelect | undefined;
    let testSend: typeof testSends.$inferSelect | undefined;
    if (msgTag && UUID.test(msgTag)) {
      if (purpose === "test_send") testSend = (await tx.select().from(testSends).where(eq(testSends.id, msgTag)).limit(1))[0];
      else message = (await tx.select().from(messages).where(eq(messages.id, msgTag)).limit(1))[0];
    }
    if (!message && !testSend && providerMessageId) {
      message = (await tx.select().from(messages).where(eq(messages.providerMessageId, providerMessageId)).limit(1))[0];
      if (!message) testSend = (await tx.select().from(testSends).where(eq(testSends.providerMessageId, providerMessageId)).limit(1))[0];
    }

    // ---- dedupe
    const ins = await tx
      .insert(messageEvents)
      .values({
        messageId: message?.id ?? null,
        campaignId: message?.campaignId ?? null,
        testSendId: testSend?.id ?? null,
        type: c.type,
        providerEventId: snsMessageId,
        providerMessageId,
        occurredAt: c.occurredAt ? new Date(c.occurredAt) : null,
        receivedAt: clock.now(),
        detail: { ...c.detail, attempt: tag("attempt") ?? null },
      })
      .onConflictDoNothing({ target: messageEvents.providerEventId })
      .returning({ id: messageEvents.id });
    const matched: IngestResult["matched"] = message ? "campaign" : testSend ? "test_send" : "none";
    if (!ins.length) return { status: "duplicate", type: c.type, matched };

    const now = clock.now();
    let reconciled = false;
    if (message) {
      // Any provider evidence for the message proves SES accepted it.
      if (message.sendStatus === "unknown" || message.sendStatus === "marked_not_sent") {
        const r = await tx
          .update(messages)
          .set({ sendStatus: "sent", providerMessageId: message.providerMessageId ?? providerMessageId, sentAt: message.sentAt ?? (ev.mail?.timestamp ? new Date(ev.mail.timestamp) : now), errorCode: null, updatedAt: now })
          .where(and(eq(messages.id, message.id), inArray(messages.sendStatus, ["unknown", "marked_not_sent"])))
          .returning({ id: messages.id });
        reconciled = r.length > 0;
        if (reconciled) {
          await writeAudit(t, { actor: "system:ses", action: "message.reconciled_sent", entityType: "message", entityId: message.id, before: { sendStatus: message.sendStatus }, after: { evidence: c.type }, correlationId: opts.correlationId });
        }
      }
      if (c.delivery && RANK[c.delivery] > RANK[message.deliveryStatus]) {
        await tx.update(messages).set({ deliveryStatus: c.delivery, updatedAt: now }).where(eq(messages.id, message.id));
      }
    }
    if (testSend && testSend.status === "unknown") {
      const r = await tx.update(testSends).set({ status: "accepted", providerMessageId: testSend.providerMessageId ?? providerMessageId, completedAt: now }).where(and(eq(testSends.id, testSend.id), eq(testSends.status, "unknown"))).returning({ id: testSends.id });
      reconciled = r.length > 0;
    }

    // ---- automatic suppression (follows the address, whatever the message)
    let suppressed = 0;
    if (c.type === "bounce_hard" || c.type === "complaint") {
      const addrs = (c.type === "bounce_hard" ? ev.bounce?.bouncedRecipients : ev.complaint?.complainedRecipients)?.map((r) => r.emailAddress).filter((x): x is string => Boolean(x)) ?? [];
      const fallback = message?.emailNormalized ?? testSend?.recipientEmail;
      const list = [...new Set((addrs.length ? addrs : fallback ? [fallback] : []).map((a) => a.trim().toLowerCase()))];
      for (const email of list) {
        const r = await suppressAddress(tx, {
          email,
          reason: c.type === "bounce_hard" ? "hard_bounce" : "complaint",
          source: "ses_event",
          createdBy: "system:ses",
          campaignId: message?.campaignId ?? null,
          note: c.type === "bounce_hard" ? `hard bounce (${String(c.detail.bounceSubType ?? "")})` : "complaint",
          withdrawConsent: c.type === "complaint" ? { source: "system", evidenceNote: "Recipient marked the email as spam (SES complaint event).", correlationId: opts.correlationId } : undefined,
        });
        if (r.added) suppressed++;
      }
    }

    // ---- a finished campaign with a new problem is never shown as a clean success
    if (message && ["bounce_hard", "bounce_soft", "complaint", "reject"].includes(c.type)) {
      const camp = await loadCampaign(tx, message.campaignId);
      if (camp?.status === "completed") await transition(tx, camp, "completed_with_issues", "system:ses", `${c.type} received after completion`, { now });
    }
    log.info({ type: c.type, matched, reconciled, suppressed }, "SES event processed");
    return { status: "processed", type: c.type, matched, reconciled, suppressed };
  });
}
