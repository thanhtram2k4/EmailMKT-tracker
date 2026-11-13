/** Read models for the Campaigns and Suppressions screens. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaignSnapshots, campaignTransitions, campaigns, suppressions, templateVersions } from "../db/schema";
import { UNKNOWN_RESOLVE_AFTER_MS } from "./service";
import { messageCounts, type MessageCounts } from "./state";

export async function listCampaigns(db: Db) {
  const r = await db.execute(sql`
    select c.id, c.name, c.status::text as status, c.updated_at, c.created_at, c.approved_at, c.finished_at, t.name as template_name,
      (select count(*)::int from messages m where m.campaign_id = c.id and m.snapshot_id = c.snapshot_id) as total,
      (select count(*)::int from messages m where m.campaign_id = c.id and m.snapshot_id = c.snapshot_id and m.send_status = 'sent') as sent
    from campaigns c join templates t on t.id = c.template_id
    order by c.created_at desc limit 200`);
  return r.rows as Array<{ id: string; name: string; status: string; updated_at: string; created_at: string; approved_at: string | null; finished_at: string | null; template_name: string; total: number; sent: number }>;
}

export async function templateChoices(db: Db) {
  const r = await db.execute(sql`
    select t.id, t.name, v.id as version_id, v.version_no, v.subject
    from templates t
    join lateral (select id, version_no, subject from template_versions where template_id = t.id order by version_no desc limit 1) v on true
    where t.source_kind <> 'fixture'
    order by t.updated_at desc`);
  return r.rows as Array<{ id: string; name: string; version_id: string; version_no: number; subject: string | null }>;
}

export async function versionsOf(db: Db, templateId: string) {
  return db
    .select({ id: templateVersions.id, versionNo: templateVersions.versionNo, subject: templateVersions.subject, createdAt: templateVersions.createdAt })
    .from(templateVersions)
    .where(eq(templateVersions.templateId, templateId))
    .orderBy(desc(templateVersions.versionNo));
}

export type RecipientFilter = "all" | "sent" | "pending" | "unknown" | "skipped" | "failed_permanent" | "cancelled" | "bounced" | "complained" | "delivered";

export async function campaignDetail(db: Db, id: string, o: { now?: Date; filter?: RecipientFilter } = {}) {
  const c = (await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1))[0];
  if (!c) return null;
  const now = o.now ?? new Date();
  const [tpl, snap, counts, transitions] = await Promise.all([
    db.execute(sql`select name from templates where id = ${c.templateId}`),
    c.snapshotId ? db.select().from(campaignSnapshots).where(eq(campaignSnapshots.id, c.snapshotId)).limit(1) : Promise.resolve([]),
    messageCounts(db, id),
    db.select().from(campaignTransitions).where(eq(campaignTransitions.campaignId, id)).orderBy(desc(campaignTransitions.id)).limit(50),
  ]);
  const cutoff = new Date(now.getTime() - UNKNOWN_RESOLVE_AFTER_MS);
  const ready = (await db.execute(sql`select count(*)::int as n from messages where campaign_id = ${id} and snapshot_id = ${c.snapshotId ?? null}::uuid and send_status = 'unknown' and claimed_at < ${cutoff.toISOString()}::timestamptz`)).rows[0] as { n: number };
  const f = o.filter ?? "all";
  const where =
    f === "all"
      ? sql`true`
      : f === "bounced"
        ? sql`m.delivery_status in ('bounced_hard', 'bounced_soft')`
        : f === "complained" || f === "delivered"
          ? sql`m.delivery_status = ${f}`
          : sql`m.send_status = ${f}`;
  const recipients = (
    await db.execute(sql`
      select m.id, m.email_normalized, m.send_status::text as send_status, m.delivery_status::text as delivery_status, m.skip_reason,
             m.attempt_no, m.sent_at, m.error_code, m.last_error, m.resolution, r.merge_values->>'full_name' as full_name
      from messages m join campaign_recipients r on r.id = m.recipient_id
      where m.campaign_id = ${id} and m.snapshot_id = ${c.snapshotId ?? null}::uuid and ${where}
      order by r.merge_values->>'full_name' nulls last, m.email_normalized
      limit 200`)
  ).rows as Array<{ id: string; email_normalized: string; send_status: string; delivery_status: string; skip_reason: string | null; attempt_no: number; sent_at: string | null; error_code: string | null; last_error: string | null; resolution: string | null; full_name: string | null }>;
  return {
    campaign: c,
    templateName: (tpl.rows[0] as { name: string } | undefined)?.name ?? "—",
    snapshot: (snap as Array<typeof campaignSnapshots.$inferSelect>)[0] ?? null,
    counts: counts as MessageCounts,
    transitions,
    uncertainReady: ready.n,
    recipients,
  };
}

export type SuppressionFilter = { q?: string; reason?: string };

export async function listSuppressions(db: Db, f: SuppressionFilter = {}) {
  const where = [sql`true`];
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    where.push(sql`s.email_normalized like ${like}`);
  }
  if (f.reason) where.push(sql`s.reason::text = ${f.reason}`);
  const r = await db.execute(sql`
    select s.email_normalized, s.reason::text as reason, s.source, s.created_at, s.created_by, s.note, s.campaign_id, c.name as campaign_name
    from suppressions s left join campaigns c on c.id = s.campaign_id
    where ${sql.join(where, sql` and `)}
    order by s.created_at desc limit 500`);
  const total = (await db.execute(sql`select reason::text as reason, count(*)::int as n from suppressions group by reason`)).rows as Array<{ reason: string; n: number }>;
  return { rows: r.rows as Array<{ email_normalized: string; reason: string; source: string; created_at: string; created_by: string; note: string | null; campaign_id: string | null; campaign_name: string | null }>, byReason: total };
}

export async function isSuppressed(db: Db, email: string) {
  return (await db.select({ e: suppressions.emailNormalized }).from(suppressions).where(and(eq(suppressions.emailNormalized, email))).limit(1)).length > 0;
}

/** M6: scheduled list (scheduled and held first, then recent starts), with local and UTC times. */
export async function scheduledCampaigns(db: Db) {
  const r = await db.execute(sql`
    select c.id, c.name, c.status::text as status, c.scheduled_at_utc, c.schedule_tz, c.schedule_local, c.schedule_offset_minutes,
           c.schedule_revision, c.processing_started_at, c.start_delay_ms, c.hold_reason, c.scheduled_by,
           (select count(*)::int from messages m where m.campaign_id = c.id and m.snapshot_id = c.snapshot_id) as recipients,
           (select count(*)::int from messages m where m.campaign_id = c.id and m.snapshot_id = c.snapshot_id and m.send_status = 'sent') as sent
    from campaigns c
    where c.scheduled_at_utc is not null
      and (c.status in ('scheduled', 'held_overdue') or c.scheduled_at_utc > now() - interval '14 days')
    order by case c.status when 'held_overdue' then 0 when 'scheduled' then 1 else 2 end, c.scheduled_at_utc asc
    limit 200`);
  return r.rows as Array<{
    id: string;
    name: string;
    status: string;
    scheduled_at_utc: string;
    schedule_tz: string;
    schedule_local: string;
    schedule_offset_minutes: number;
    schedule_revision: number;
    processing_started_at: string | null;
    start_delay_ms: number | null;
    hold_reason: string | null;
    scheduled_by: string | null;
    recipients: number;
    sent: number;
  }>;
}
