/**
 * M7 metric engine (DESIGN §4.3 "Metric definitions"). Test sends are excluded by construction: they
 * have no campaign message, so they never produce campaign events.
 *  - Sent = SES accepted; Delivered = SES Delivery event (recipient server accepted, not inbox).
 *  - Unique openers / clickers are counted PER MESSAGE (one recipient per campaign); totals are raw.
 *    A recipient who clicked without a recorded open (images blocked) counts as an opener: a click
 *    implies the email was opened, and CTOR can then never exceed 100% (found in the M7 visual review).
 *    3 clicks on one link = 1 unique clicker and 3 recorded clicks.
 *  - Rates are "of Delivered", with "of Sent" alongside; CTOR = unique clickers / unique openers.
 *  - Every metric exists twice: all recorded events, and with suspected automated activity removed.
 * Only the campaign's current snapshot counts (an unscheduled earlier approval is history).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { messageCounts, type MessageCounts } from "./state";

export type Engagement = { uniqueOpeners: number; totalOpens: number; uniqueClickers: number; totalClicks: number };

export type CampaignAnalytics = {
  counts: MessageCounts;
  /** Messages sent with tracking (consent / setting at send time). */
  tracked: number;
  recorded: Engagement;
  filtered: Engagement;
  unsubscribes: number;
  firstActivity: Date | null;
  latestActivity: Date | null;
  automatedEvents: number;
};

const eng = (r: Record<string, unknown>, p: string): Engagement => ({
  uniqueOpeners: Number(r[`${p}_uo`] ?? 0),
  totalOpens: Number(r[`${p}_to`] ?? 0),
  uniqueClickers: Number(r[`${p}_uc`] ?? 0),
  totalClicks: Number(r[`${p}_tc`] ?? 0),
});

export async function campaignAnalytics(db: Db, campaignId: string): Promise<CampaignAnalytics> {
  const counts = await messageCounts(db, campaignId);
  const r = (
    await db.execute(sql`
      with cur as (select m.id, m.tracking_enabled, m.send_status from messages m
                   join campaigns c on c.id = m.campaign_id and m.snapshot_id = c.snapshot_id
                   where m.campaign_id = ${campaignId}),
           ev as (select e.* from message_events e join cur on cur.id = e.message_id where e.type in ('open', 'click', 'unsubscribe'))
      select
        (select count(*)::int from cur where tracking_enabled and send_status in ('sent', 'unknown', 'marked_not_sent')) as tracked,
        count(distinct message_id) filter (where type in ('open', 'click'))::int as all_uo,
        count(*) filter (where type = 'open')::int as all_to,
        count(distinct message_id) filter (where type = 'click')::int as all_uc,
        count(*) filter (where type = 'click')::int as all_tc,
        count(distinct message_id) filter (where type in ('open', 'click') and not suspected_automated)::int as f_uo,
        count(*) filter (where type = 'open' and not suspected_automated)::int as f_to,
        count(distinct message_id) filter (where type = 'click' and not suspected_automated)::int as f_uc,
        count(*) filter (where type = 'click' and not suspected_automated)::int as f_tc,
        count(distinct message_id) filter (where type = 'unsubscribe')::int as unsubscribes,
        count(*) filter (where suspected_automated)::int as automated,
        min(occurred_at) filter (where type in ('open', 'click')) as first_at,
        max(occurred_at) filter (where type in ('open', 'click')) as latest_at
      from ev`)
  ).rows[0] as Record<string, unknown>;
  return {
    counts,
    tracked: Number(r.tracked ?? 0),
    recorded: eng(r, "all"),
    filtered: eng(r, "f"),
    unsubscribes: Number(r.unsubscribes ?? 0),
    automatedEvents: Number(r.automated ?? 0),
    firstActivity: r.first_at ? new Date(String(r.first_at)) : null,
    latestActivity: r.latest_at ? new Date(String(r.latest_at)) : null,
  };
}

/** A rate as a percentage string, or "—" when the denominator is zero. */
export function rate(num: number, den: number): string {
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

export type LinkRow = {
  idx: number;
  url: string;
  label: string | null;
  uniqueAll: number;
  totalAll: number;
  uniqueFiltered: number;
  totalFiltered: number;
  first: Date | null;
  latest: Date | null;
};

export async function linkAnalytics(db: Db, campaignId: string): Promise<LinkRow[]> {
  const r = await db.execute(sql`
    select l.idx, l.url, l.label,
      count(distinct e.message_id)::int as unique_all,
      count(e.id)::int as total_all,
      count(distinct e.message_id) filter (where not e.suspected_automated)::int as unique_f,
      count(e.id) filter (where not e.suspected_automated)::int as total_f,
      min(e.occurred_at) as first_at, max(e.occurred_at) as latest_at
    from campaigns c
    join campaign_links l on l.snapshot_id = c.snapshot_id
    left join message_events e on e.campaign_id = c.id and e.type = 'click' and e.link_idx = l.idx
      and e.message_id in (select id from messages where snapshot_id = c.snapshot_id)
    where c.id = ${campaignId}
    group by l.idx, l.url, l.label
    order by l.idx`);
  return (r.rows as Array<Record<string, unknown>>).map((x) => ({
    idx: Number(x.idx),
    url: String(x.url),
    label: (x.label as string) ?? null,
    uniqueAll: Number(x.unique_all),
    totalAll: Number(x.total_all),
    uniqueFiltered: Number(x.unique_f),
    totalFiltered: Number(x.total_f),
    first: x.first_at ? new Date(String(x.first_at)) : null,
    latest: x.latest_at ? new Date(String(x.latest_at)) : null,
  }));
}

export type TimelineEvent = { at: Date; type: string; detail: string; flags: string[]; automated: boolean };

/** One recipient's timeline (send attempt, provider events, opens, clicks, unsubscribe). */
export async function recipientTimeline(db: Db, campaignId: string, messageId: string) {
  const m = (
    await db.execute(sql`
      select m.*, r.merge_values->>'full_name' as full_name from messages m join campaign_recipients r on r.id = m.recipient_id
      where m.id = ${messageId} and m.campaign_id = ${campaignId}`)
  ).rows[0] as Record<string, unknown> | undefined;
  if (!m) return null;
  const ev = (
    await db.execute(sql`
      select e.type::text as type, coalesce(e.occurred_at, e.received_at) as at, e.link_idx, e.flags, e.suspected_automated, e.detail, l.url
      from message_events e
      left join campaign_links l on l.snapshot_id = ${m.snapshot_id as string} and l.idx = e.link_idx
      where e.message_id = ${messageId}
      order by coalesce(e.occurred_at, e.received_at), e.id`)
  ).rows as Array<Record<string, unknown>>;
  const events: TimelineEvent[] = [];
  if (m.send_started_at) events.push({ at: new Date(String(m.send_started_at)), type: "send attempt", detail: `attempt ${m.attempt_no}`, flags: [], automated: false });
  if (m.sent_at) events.push({ at: new Date(String(m.sent_at)), type: "sent", detail: "provider accepted", flags: [], automated: false });
  for (const e of ev) {
    events.push({
      at: new Date(String(e.at)),
      type: String(e.type),
      detail: e.type === "click" ? `link ${e.link_idx}: ${e.url ?? "?"}` : e.type === "unsubscribe" ? String((e.detail as { method?: string } | null)?.method ?? "") : "",
      flags: (e.flags as string[]) ?? [],
      automated: Boolean(e.suspected_automated),
    });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  const activity = events.filter((e) => e.type === "open" || e.type === "click");
  return {
    message: m,
    events,
    firstActivity: activity[0]?.at ?? null,
    latestActivity: activity.at(-1)?.at ?? null,
  };
}
