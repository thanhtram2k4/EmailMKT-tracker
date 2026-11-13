/**
 * M6 scheduling (DESIGN §4.2). One-time scheduled sends with an explicit IANA time zone.
 *
 *  - Schedule: the same snapshot freeze as "Send now" (approveCampaign), ending in `scheduled` with
 *    scheduled_at_utc + schedule_tz; a `start_campaign` job is placed with job_key = start:<id> and
 *    payload { campaignId, revision }.
 *  - Fenced start: the job (and the every-minute sweeper) moves scheduled → queued ONLY if the campaign
 *    is still scheduled, at the same revision, and due. The row is locked (FOR UPDATE), so duplicate
 *    triggers, a stale job after a reschedule, and cancel races all resolve to one outcome. The queue
 *    is never trusted on its own.
 *  - Late start: within the grace period (default 30 min) the campaign proceeds and the delay is
 *    recorded; beyond it the campaign is `held_overdue` for an admin (send now, reschedule or cancel).
 *    The default is NOT to send.
 *  - Reschedule increments schedule_revision (an old job then fails the fence). Unscheduling returns the
 *    campaign to draft with a new revision; the old snapshot's unsent messages are cancelled.
 */
import { sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { Db } from "../db/client";
import { campaigns, messages } from "../db/schema";
import { getLogger } from "../logger";
import { createAlert } from "./alerts";
import { resolveScheduleTime, formatInZone, formatUtc, type ScheduleInput, type ScheduleResolution } from "./schedule-time";
import { approveCampaign, type CampaignDeps } from "./service";
import { getSendSettings } from "./settings";
import { CampaignError, transition, type CampaignRow, type Tx } from "./state";

/** Processing should start within this time after the scheduled moment (DESIGN §4.2 target). */
export const START_TARGET_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolvedOrThrow(r: ScheduleResolution): Extract<ScheduleResolution, { ok: true }> {
  if (r.ok) return r;
  const details = r.code === "nonexistent" && r.suggestion ? [`Suggested: ${r.suggestion.label}`] : r.code === "ambiguous" && r.options ? r.options.map((o) => o.label) : [];
  throw new CampaignError(r.message, details);
}

async function lockCampaign(tx: Tx, id: string): Promise<CampaignRow> {
  if (!UUID.test(id)) throw new CampaignError("Campaign not found.");
  const c = (await (tx as Db).select().from(campaigns).where(sql`${campaigns.id} = ${id}`).for("update"))[0];
  if (!c) throw new CampaignError("Campaign not found.");
  return c;
}

const scheduleSet = (r: Extract<ScheduleResolution, { ok: true }>, actor: string) => ({
  scheduledAtUtc: r.utc,
  scheduleTz: r.zone,
  scheduleLocal: r.local,
  scheduleOffsetMinutes: r.offsetMinutes,
  scheduledBy: actor,
  holdReason: null,
  startDelayMs: null,
});

export async function scheduleCampaign(
  db: Db,
  deps: CampaignDeps,
  i: { campaignId: string; expectedRevision: number; expectedRecipients: number; actor: string; correlationId?: string } & ScheduleInput,
) {
  const clock = deps.clock ?? systemClock;
  const when = resolvedOrThrow(resolveScheduleTime(i, clock.now()));
  const r = await approveCampaign(db, deps, i, {
    status: "scheduled",
    reason: `scheduled for ${when.label}`,
    auditAction: "campaign.scheduled",
    set: scheduleSet(when, i.actor),
    auditExtra: { scheduledAtUtc: when.utc.toISOString(), zone: when.zone, local: when.local, offsetMinutes: when.offsetMinutes },
  });
  await deps.scheduleStart?.(i.campaignId, r.revision, when.utc);
  return { ...r, scheduledAtUtc: when.utc, label: when.label };
}

export async function rescheduleCampaign(db: Db, deps: CampaignDeps, i: { campaignId: string; actor: string; correlationId?: string } & ScheduleInput) {
  const clock = deps.clock ?? systemClock;
  const when = resolvedOrThrow(resolveScheduleTime(i, clock.now()));
  const r = await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    if (c.status !== "scheduled" && c.status !== "held_overdue") throw new CampaignError(`Only a scheduled or held campaign can be rescheduled (this one is ${c.status}).`);
    const before = { scheduledAtUtc: c.scheduledAtUtc?.toISOString(), zone: c.scheduleTz, revision: c.scheduleRevision };
    const ok = await transition(tx, c, "scheduled", i.actor, `rescheduled to ${when.label}`, {
      set: { ...scheduleSet(when, i.actor), scheduleRevision: c.scheduleRevision + 1 },
      detail: { before, after: { scheduledAtUtc: when.utc.toISOString(), zone: when.zone, revision: c.scheduleRevision + 1 } },
      correlationId: i.correlationId,
      now: clock.now(),
    });
    if (!ok) throw new CampaignError("The campaign changed meanwhile. Reload and try again.");
    await writeAudit(tx as unknown as Db, {
      actor: i.actor,
      action: "campaign.rescheduled",
      entityType: "campaign",
      entityId: c.id,
      before,
      after: { scheduledAtUtc: when.utc.toISOString(), zone: when.zone, local: when.local, revision: c.scheduleRevision + 1 },
      correlationId: i.correlationId,
    });
    return { revision: c.scheduleRevision + 1 };
  });
  await deps.scheduleStart?.(i.campaignId, r.revision, when.utc);
  return { ...r, scheduledAtUtc: when.utc, label: when.label };
}

/** "Edit after scheduling": back to draft, new revision, schedule removed, unsent messages cancelled. */
export async function unscheduleToDraft(db: Db, deps: Pick<CampaignDeps, "removeStart" | "clock">, i: { campaignId: string; actor: string; correlationId?: string }) {
  const now = (deps.clock ?? systemClock).now();
  await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    if (c.status !== "scheduled" && c.status !== "held_overdue") throw new CampaignError(`Only a scheduled or held campaign can be unscheduled (this one is ${c.status}).`);
    await tx.execute(sql`update ${messages} set send_status = 'cancelled', updated_at = ${now.toISOString()}::timestamptz
                         where campaign_id = ${c.id} and send_status = 'pending'`);
    const ok = await transition(tx, c, "draft", i.actor, "Schedule removed — review and confirm again", {
      set: {
        snapshotId: null,
        approvedBy: null,
        approvedAt: null,
        scheduledAtUtc: null,
        scheduleTz: null,
        scheduleLocal: null,
        scheduleOffsetMinutes: null,
        scheduledBy: null,
        holdReason: null,
        startDelayMs: null,
        scheduleRevision: c.scheduleRevision + 1,
      },
      detail: { previousSnapshotId: c.snapshotId, previousScheduledAtUtc: c.scheduledAtUtc?.toISOString() ?? null },
      correlationId: i.correlationId,
      now,
    });
    if (!ok) throw new CampaignError("The campaign changed meanwhile. Reload and try again.");
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "campaign.unscheduled", entityType: "campaign", entityId: c.id, before: { status: c.status, snapshotId: c.snapshotId }, correlationId: i.correlationId });
  });
  await deps.removeStart?.(i.campaignId);
}

/** Admin decision on a held (overdue) campaign: send it now. */
export async function sendOverdueNow(db: Db, deps: Pick<CampaignDeps, "enqueue" | "clock">, i: { campaignId: string; actor: string; correlationId?: string }) {
  const now = (deps.clock ?? systemClock).now();
  await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    if (c.status !== "held_overdue") throw new CampaignError(`Only a held campaign can be sent this way (this one is ${c.status}).`);
    await transition(tx, c, "queued", i.actor, "held campaign released: send now", { set: { holdReason: null, processingStartedAt: now }, correlationId: i.correlationId, now });
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "campaign.overdue_send_now", entityType: "campaign", entityId: c.id, correlationId: i.correlationId });
  });
  await deps.enqueue(i.campaignId);
}

export type StartResult = { result: "started" | "held_overdue" | "early" | "stale" | "not_scheduled" | "not_found"; delayMs?: number };

/**
 * The fenced start, run by the start_campaign job and by the every-minute sweeper. `revision` is the
 * job's payload revision; the sweeper passes the current one. Never sends anything itself: on
 * success the campaign is `queued` and the caller queues the dispatcher.
 */
export async function startScheduled(db: Db, i: { campaignId: string; revision?: number; trigger: string }, o: { clock?: Clock } = {}): Promise<StartResult> {
  const clock = o.clock ?? systemClock;
  const log = getLogger().child({ campaign_id: i.campaignId, task: "start_campaign", trigger: i.trigger, schedule_revision: i.revision });
  if (!UUID.test(i.campaignId)) return { result: "not_found" };
  const settings = await getSendSettings(db);
  const r = await db.transaction(async (tx): Promise<StartResult> => {
    const c = (await tx.select().from(campaigns).where(sql`${campaigns.id} = ${i.campaignId}`).for("update"))[0];
    if (!c) return { result: "not_found" };
    if (c.status !== "scheduled") return { result: "not_scheduled" };
    if (i.revision !== undefined && i.revision !== c.scheduleRevision) return { result: "stale" };
    const now = clock.now();
    if (!c.scheduledAtUtc || c.scheduledAtUtc.getTime() > now.getTime()) return { result: "early" };
    const delayMs = now.getTime() - c.scheduledAtUtc.getTime();
    const detail = { scheduledAtUtc: c.scheduledAtUtc.toISOString(), zone: c.scheduleTz, startedAt: now.toISOString(), delayMs, revision: c.scheduleRevision, trigger: i.trigger };

    if (delayMs > settings.graceMinutes * 60_000) {
      const reason = `Not started: ${Math.round(delayMs / 60_000)} min after the scheduled time ${formatInZone(c.scheduledAtUtc, c.scheduleTz ?? "UTC")}, beyond the ${settings.graceMinutes}-minute grace period (e.g. the worker was down). Nothing was sent. An administrator decides: send now, reschedule or cancel.`;
      await transition(tx, c, "held_overdue", "system", "held: later than the grace period", { set: { holdReason: reason, startDelayMs: delayMs }, detail, now });
      await createAlert(tx, { kind: "held_overdue", campaignId: c.id, message: `Campaign “${c.name}” is held. ${reason}` });
      await writeAudit(tx as unknown as Db, { actor: "system", action: "campaign.held_overdue", entityType: "campaign", entityId: c.id, after: detail });
      return { result: "held_overdue", delayMs };
    }
    const reason =
      delayMs <= START_TARGET_MS
        ? `scheduled start (${Math.round(delayMs / 1000)} s after ${formatUtc(c.scheduledAtUtc)})`
        : `late start: ${Math.round(delayMs / 1000)} s after the scheduled time, within the ${settings.graceMinutes}-minute grace period (${i.trigger})`;
    await transition(tx, c, "queued", "system", reason, { set: { processingStartedAt: now, startDelayMs: delayMs }, detail, now });
    return { result: "started", delayMs };
  });
  if (r.result === "started") (r.delayMs! > START_TARGET_MS ? log.warn.bind(log) : log.info.bind(log))({ delay_ms: r.delayMs }, "scheduled campaign started");
  else if (r.result === "held_overdue") log.warn({ delay_ms: r.delayMs }, "scheduled campaign held: beyond the grace period");
  else log.debug({ result: r.result }, "start trigger was a no-op");
  return r;
}

/** Scheduled campaigns that are due (for the sweeper). */
export async function dueScheduledCampaigns(db: Db, now: Date): Promise<Array<{ id: string; revision: number }>> {
  const r = await db.execute(sql`select id, schedule_revision as revision from campaigns where status = 'scheduled' and scheduled_at_utc <= ${now.toISOString()}::timestamptz order by scheduled_at_utc`);
  return r.rows as Array<{ id: string; revision: number }>;
}
