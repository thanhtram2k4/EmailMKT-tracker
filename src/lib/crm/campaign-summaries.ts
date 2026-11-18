/**
 * M8: campaign summaries in Notion and the contacts' engagement write-back (DESIGN §3.3, §7 M8).
 *
 *  - "Email Campaigns" database: created by an admin under a parent page (fixed schema), using the
 *    stored connection token. Like the CRM database, the create request is never retried.
 *  - Summaries: one page per finished campaign, rewritten at stages after it finished — on completion,
 *    +24 h, +72 h and +7 days — with sending, delivery and (filtered) engagement figures.
 *    The page is found by its "Campaign ID" before anything is created; a page is created only when a
 *    fresh query finds none, so an uncertain earlier create cannot produce a second page unless Notion
 *    lost it. Property updates are absolute values (idempotent). Failures never affect sending; they are
 *    recorded on the summary row and shown in the app.
 *  - Contacts: "Last emailed" / "Last engagement" (app-owned) are queued through notion_outbox
 *    (coalesced per page, rate limited, retried) when they changed since they were last queued.
 */
import { and, eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import { campaignAnalytics } from "../campaigns/analytics";
import type { Db } from "../db/client";
import { campaignNotionSummaries, campaigns, notionConnection } from "../db/schema";
import { getLogger } from "../logger";
import { NotionUncertainError } from "../notion/client";
import { friendlyNotionError, parseNotionId } from "./connection";
import { clientForConnection, type NotionEnv } from "./notion-env";

export const SUMMARY_STAGES = [
  { key: "completion", label: "On completion", afterMs: 0 },
  { key: "24h", label: "+24 h", afterMs: 24 * 3600_000 },
  { key: "72h", label: "+72 h", afterMs: 72 * 3600_000 },
  { key: "7d", label: "+7 days", afterMs: 7 * 24 * 3600_000 },
] as const;
export type SummaryStage = (typeof SUMMARY_STAGES)[number];

const num = (format: "number" | "percent") => ({ number: { format } });
export const CAMPAIGNS_DATABASE_PROPERTIES: Record<string, unknown> = {
  Name: { title: {} },
  "Campaign ID": { rich_text: {} },
  Status: { select: { options: ["completed", "completed_with_issues", "cancelled", "failed"].map((name) => ({ name })) } },
  "Summary stage": { select: { options: SUMMARY_STAGES.map((s) => ({ name: s.label })) } },
  Scheduled: { date: {} },
  Started: { date: {} },
  Finished: { date: {} },
  Recipients: num("number"),
  Sent: num("number"),
  Delivered: num("number"),
  Bounced: num("number"),
  Complaints: num("number"),
  Unsubscribes: num("number"),
  Uncertain: num("number"),
  "Unique openers": num("number"),
  "Unique clickers": num("number"),
  "Open rate (of Delivered)": num("percent"),
  "Click rate (of Delivered)": num("percent"),
  "Last updated": { date: {} },
};

/** The latest stage that is due and not yet written (writing it also covers earlier missed stages). */
export function dueStage(finishedAt: Date, done: string[], now: Date): SummaryStage | null {
  const due = SUMMARY_STAGES.filter((s) => finishedAt.getTime() + s.afterMs <= now.getTime());
  const latest = due.at(-1);
  return latest && !done.includes(latest.key) ? latest : null;
}

export async function createCampaignsDatabase(db: Db, env: NotionEnv, i: { parentPageIdOrUrl: string; title?: string; actor: string; correlationId?: string }) {
  const parent = parseNotionId(i.parentPageIdOrUrl);
  if (!parent) return { ok: false as const, error: "Could not find a page ID in that value." };
  const c = await clientForConnection(db, env);
  if (!c) return { ok: false as const, error: "Connect Notion first (the CRM connection's token is used)." };
  if (c.conn.campaignsDataSourceId) return { ok: false as const, error: "An Email Campaigns database is already connected." };
  const title = i.title?.trim() || "Email Campaigns";
  try {
    const created = await c.client.createDatabase({
      parent: { type: "page_id", page_id: parent },
      title: [{ type: "text", text: { content: title } }],
      initial_data_source: { properties: CAMPAIGNS_DATABASE_PROPERTIES },
    });
    const dsId = created.data_sources?.[0]?.id;
    if (!dsId) return { ok: false as const, error: "Notion created the database without a data source." };
    await db.update(notionConnection).set({ campaignsDatabaseId: created.id, campaignsDataSourceId: dsId, updatedAt: new Date() }).where(eq(notionConnection.id, "default"));
    await writeAudit(db, { actor: i.actor, action: "crm.notion_campaigns_database_created", entityType: "notion_connection", entityId: created.id, after: { title, parentPageId: parent, dataSourceId: dsId }, correlationId: i.correlationId });
    return { ok: true as const, databaseId: created.id, dataSourceId: dsId };
  } catch (e) {
    return { ok: false as const, error: friendlyNotionError(e) };
  }
}

const text = (s: string) => [{ type: "text", text: { content: s.slice(0, 2000) } }];
const date = (d: Date | null | undefined) => ({ date: d ? { start: d.toISOString() } : null });
const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : null);

export async function summaryProperties(db: Db, c: typeof campaigns.$inferSelect, stage: SummaryStage, now: Date): Promise<Record<string, unknown>> {
  const a = await campaignAnalytics(db, c.id);
  const k = a.counts;
  return {
    Name: { title: text(c.name) },
    "Campaign ID": { rich_text: text(c.id) },
    Status: { select: { name: c.status } },
    "Summary stage": { select: { name: stage.label } },
    Scheduled: date(c.scheduledAtUtc),
    Started: date(c.processingStartedAt),
    Finished: date(c.finishedAt),
    Recipients: { number: k.total },
    Sent: { number: k.sent },
    Delivered: { number: k.delivered },
    Bounced: { number: k.bounced_hard + k.bounced_soft },
    Complaints: { number: k.complained },
    Unsubscribes: { number: a.unsubscribes },
    Uncertain: { number: k.unknown },
    "Unique openers": { number: a.filtered.uniqueOpeners },
    "Unique clickers": { number: a.filtered.uniqueClickers },
    "Open rate (of Delivered)": { number: ratio(a.filtered.uniqueOpeners, k.delivered) },
    "Click rate (of Delivered)": { number: ratio(a.filtered.uniqueClickers, k.delivered) },
    "Last updated": date(now),
  };
}

export type SummaryRun = { configured: boolean; written: number; failed: number; considered: number };

export async function writeCampaignSummaries(db: Db, env: NotionEnv, o: { now?: Date; limit?: number } = {}): Promise<SummaryRun> {
  const now = o.now ?? new Date();
  const log = getLogger().child({ task: "notion_campaign_summaries" });
  const conn = await clientForConnection(db, env);
  if (!conn?.conn.campaignsDataSourceId) return { configured: false, written: 0, failed: 0, considered: 0 };
  const dsId = conn.conn.campaignsDataSourceId;
  // Finished campaigns that actually went out (a cancelled draft has no snapshot).
  const rows = (
    await db.execute(sql`
      select c.id, coalesce(s.stages_done, '{}') as stages_done
      from campaigns c left join campaign_notion_summaries s on s.campaign_id = c.id
      where c.status in ('completed', 'completed_with_issues', 'cancelled', 'failed') and c.finished_at is not null and c.snapshot_id is not null
        and coalesce(cardinality(s.stages_done), 0) < ${SUMMARY_STAGES.length}
      order by c.finished_at limit 200`)
  ).rows as Array<{ id: string; stages_done: string[] }>;
  const r: SummaryRun = { configured: true, written: 0, failed: 0, considered: 0 };
  for (const row of rows) {
    if (r.written + r.failed >= (o.limit ?? 20)) break;
    const c = (await db.select().from(campaigns).where(eq(campaigns.id, row.id)).limit(1))[0];
    const stage = dueStage(c.finishedAt!, row.stages_done, now);
    if (!stage) continue;
    r.considered++;
    await db.insert(campaignNotionSummaries).values({ campaignId: c.id }).onConflictDoNothing();
    const state = (await db.select().from(campaignNotionSummaries).where(eq(campaignNotionSummaries.campaignId, c.id)).limit(1))[0];
    try {
      const props = await summaryProperties(db, c, stage, now);
      let pageId = state.notionPageId;
      if (!pageId) {
        // Look up first: an earlier create may have succeeded although its answer was lost.
        const found = await conn.client.queryDataSource(dsId, { filter: { property: "Campaign ID", rich_text: { equals: c.id } }, page_size: 1 });
        pageId = found.results[0]?.id ?? null;
      }
      if (pageId) await conn.client.updatePageProperties(pageId, props);
      else pageId = (await conn.client.createPage({ parent: { type: "data_source_id", data_source_id: dsId }, properties: props })).id;
      const doneKeys = SUMMARY_STAGES.filter((s) => c.finishedAt!.getTime() + s.afterMs <= now.getTime()).map((s) => s.key);
      await db
        .update(campaignNotionSummaries)
        .set({ notionPageId: pageId, stagesDone: doneKeys, lastStage: stage.key, lastWrittenAt: now, lastError: null, attempts: 0, updatedAt: now })
        .where(eq(campaignNotionSummaries.campaignId, c.id));
      r.written++;
    } catch (e) {
      const msg = e instanceof NotionUncertainError ? `Uncertain: Notion did not answer the create; the page will be looked up before any new create. (${e.message})` : friendlyNotionError(e);
      await db
        .update(campaignNotionSummaries)
        .set({ lastError: msg.slice(0, 500), attempts: sql`${campaignNotionSummaries.attempts} + 1`, updatedAt: now })
        .where(eq(campaignNotionSummaries.campaignId, c.id));
      r.failed++;
      log.warn({ campaign_id: c.id, stage: stage.key, err: msg }, "campaign summary write failed (sending is not affected)");
    }
  }
  return r;
}

/**
 * Queue "Last emailed" / "Last engagement" for contacts whose values changed since they were last
 * queued. Only when those properties are mapped (as dates). Returns the number queued.
 */
export async function queueEngagementWrites(db: Db, env: NotionEnv, o: { now?: Date; limit?: number } = {}): Promise<number> {
  const conn = await clientForConnection(db, env);
  if (!conn) return 0;
  const f = conn.mapping.fields;
  const t = conn.mapping.types as Record<string, string | undefined>;
  const lastEmailed = f.lastEmailed && t.lastEmailed === "date" ? f.lastEmailed : null;
  const lastEngagement = f.lastEngagement && t.lastEngagement === "date" ? f.lastEngagement : null;
  if (!lastEmailed && !lastEngagement) return 0;
  const now = o.now ?? new Date();
  const rows = (
    await db.execute(sql`
      select id, notion_page_id, last_emailed_at, last_engagement_at from contacts
      where state = 'active'
        and greatest(last_emailed_at, last_engagement_at) > coalesce(engagement_queued_at, '-infinity'::timestamptz)
      order by greatest(last_emailed_at, last_engagement_at) limit ${o.limit ?? 500}`)
  ).rows as Array<{ id: string; notion_page_id: string; last_emailed_at: string | null; last_engagement_at: string | null }>;
  for (const c of rows) {
    const payload = {
      lastEmailed: c.last_emailed_at ? new Date(c.last_emailed_at).toISOString() : null,
      lastEngagement: c.last_engagement_at ? new Date(c.last_engagement_at).toISOString() : null,
    };
    await db.execute(sql`
      insert into notion_outbox (notion_page_id, kind, payload, reason)
      values (${c.notion_page_id}, 'set_engagement', ${JSON.stringify(payload)}::jsonb, 'last emailed / last engagement changed')
      on conflict (notion_page_id, kind) where status = 'pending'
      do update set payload = excluded.payload, reason = excluded.reason, attempts = 0, next_attempt_at = now(), updated_at = now(), last_error = null`);
    await db.execute(sql`update contacts set engagement_queued_at = ${now.toISOString()}::timestamptz where id = ${c.id}`);
  }
  return rows.length;
}

/** Summary status for one campaign (campaign page). */
export async function summaryStatus(db: Db, campaignId: string) {
  return (await db.select().from(campaignNotionSummaries).where(and(eq(campaignNotionSummaries.campaignId, campaignId))).limit(1))[0] ?? null;
}
