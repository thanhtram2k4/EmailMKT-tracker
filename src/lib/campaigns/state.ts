/**
 * Campaign status changes. Every change is a FENCED conditional update (only from the status the
 * caller saw) plus an append-only campaign_transitions row, so concurrent actors (staff, dispatcher,
 * event handler) can never both "win" a transition.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaigns, campaignTransitions } from "../db/schema";

export type CampaignStatus = (typeof campaigns.$inferSelect)["status"];
export type CampaignRow = typeof campaigns.$inferSelect;

/** Accepts the Db or a transaction handle. */
export type Tx = Pick<Db, "select" | "update" | "insert" | "execute">;

export const ACTIVE_STATUSES: CampaignStatus[] = ["scheduled", "held_overdue", "queued", "sending", "paused", "blocked", "cancelling"];
export const FINISHED_STATUSES: CampaignStatus[] = ["completed", "completed_with_issues", "cancelled", "failed"];

export class CampaignError extends Error {
  constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

export async function transition(
  tx: Tx,
  c: Pick<CampaignRow, "id" | "status" | "scheduleRevision">,
  to: CampaignStatus,
  actor: string,
  reason: string | null,
  extra: { set?: Partial<typeof campaigns.$inferInsert>; detail?: unknown; correlationId?: string; now?: Date } = {},
): Promise<boolean> {
  const now = extra.now ?? new Date();
  const rows = await tx
    .update(campaigns)
    .set({ ...extra.set, status: to, updatedAt: now })
    .where(and(eq(campaigns.id, c.id), eq(campaigns.status, c.status)))
    .returning({ id: campaigns.id, rev: campaigns.scheduleRevision });
  if (!rows.length) return false;
  await tx.insert(campaignTransitions).values({
    campaignId: c.id,
    fromStatus: c.status,
    toStatus: to,
    actor,
    reason,
    scheduleRevision: rows[0].rev,
    detail: extra.detail ?? null,
    correlationId: extra.correlationId ?? null,
    at: now,
  });
  return true;
}

export type MessageCounts = {
  total: number;
  pending: number;
  claimed: number;
  sent: number;
  failed_permanent: number;
  skipped: number;
  cancelled: number;
  unknown: number;
  marked_not_sent: number;
  delivered: number;
  delayed: number;
  bounced_soft: number;
  bounced_hard: number;
  complained: number;
  rejected: number;
};

export async function messageCounts(tx: Pick<Db, "execute">, campaignId: string): Promise<MessageCounts> {
  const r = await tx.execute(sql`
    select count(*)::int as total,
      count(*) filter (where send_status = 'pending')::int as pending,
      count(*) filter (where send_status = 'claimed')::int as claimed,
      count(*) filter (where send_status = 'sent')::int as sent,
      count(*) filter (where send_status = 'failed_permanent')::int as failed_permanent,
      count(*) filter (where send_status = 'skipped')::int as skipped,
      count(*) filter (where send_status = 'cancelled')::int as cancelled,
      count(*) filter (where send_status = 'unknown')::int as unknown,
      count(*) filter (where send_status = 'marked_not_sent')::int as marked_not_sent,
      count(*) filter (where delivery_status = 'delivered')::int as delivered,
      count(*) filter (where delivery_status = 'delayed')::int as delayed,
      count(*) filter (where delivery_status = 'bounced_soft')::int as bounced_soft,
      count(*) filter (where delivery_status = 'bounced_hard')::int as bounced_hard,
      count(*) filter (where delivery_status = 'complained')::int as complained,
      count(*) filter (where delivery_status = 'rejected')::int as rejected
    from messages
    -- only the current approval: an unscheduled-then-reapproved campaign keeps old messages as history
    where campaign_id = ${campaignId} and snapshot_id = (select snapshot_id from campaigns where id = ${campaignId})`);
  return r.rows[0] as MessageCounts;
}

export const hasIssues = (m: MessageCounts) => m.unknown + m.failed_permanent + m.bounced_hard + m.bounced_soft + m.complained + m.rejected + m.marked_not_sent > 0;

export async function loadCampaign(tx: Pick<Db, "select">, id: string): Promise<CampaignRow | undefined> {
  return (await tx.select().from(campaigns).where(eq(campaigns.id, id)).limit(1))[0];
}

/**
 * If nothing is pending or claimed, finish the campaign: completed, or completed_with_issues when any
 * message is unknown, failed, bounced or complained (never shown as a clean success then).
 */
export async function maybeComplete(tx: Tx, c: CampaignRow, now: Date): Promise<CampaignStatus | null> {
  if (c.status !== "sending") return null;
  const m = await messageCounts(tx, c.id);
  if (m.pending + m.claimed > 0) return null;
  const to: CampaignStatus = hasIssues(m) ? "completed_with_issues" : "completed";
  const ok = await transition(tx, c, to, "system", hasIssues(m) ? "finished with issues (see counts)" : "all messages processed", {
    set: { finishedAt: now },
    detail: m,
    now,
  });
  return ok ? to : null;
}

/**
 * Cancelling: pending messages become cancelled; once no claim is in flight the campaign is
 * cancelled, with a partial report (sent / unknown / cancelled counts). Sent mail is not recalled.
 */
export async function finalizeCancel(tx: Tx, c: CampaignRow, actor: string, now: Date): Promise<boolean> {
  if (c.status !== "cancelling") return false;
  await tx.execute(sql`update messages set send_status = 'cancelled', updated_at = ${now.toISOString()}::timestamptz
                       where campaign_id = ${c.id} and send_status = 'pending'`);
  const m = await messageCounts(tx, c.id);
  if (m.claimed > 0) return false;
  return transition(tx, c, "cancelled", actor, `cancelled: ${m.sent} sent, ${m.unknown} uncertain, ${m.cancelled} not sent`, { set: { finishedAt: now }, detail: m, now });
}
