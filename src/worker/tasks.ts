import type { Task, TaskList } from "graphile-worker";
import { getConfig } from "../lib/config";
import { flushOutbox } from "../lib/crm/outbox";
import { notionEnvFromConfig, type NotionEnv } from "../lib/crm/notion-env";
import { syncContacts, type SyncMode, type SyncTrigger } from "../lib/crm/sync";
import { getDb } from "../lib/db/client";
import { reapStaleTestSends } from "../lib/sending/test-send";
import { campaignsNeedingDispatch, dispatchCampaign, makeRuntimeMock, reapStaleMessageClaims } from "../lib/campaigns/dispatcher";
import type { MockTransport } from "../lib/sending/transport";
import { dueScheduledCampaigns, startScheduled } from "../lib/campaigns/schedule";
import { emailPendingAlerts } from "../lib/campaigns/alerts";
import { systemProbes } from "../lib/db/schema";
import { withCorrelation } from "../lib/logger";

export type SystemProbePayload = { probeId: string; enqueuedAt: string };
export type CrmSyncPayload = { mode: SyncMode; trigger: SyncTrigger; actor?: string; requestId?: string };

/**
 * Graphile cron runs in UTC.
 *  - incremental contact sync every 10 minutes;
 *  - full reconcile nightly at 19:00 UTC = 02:00 Asia/Ho_Chi_Minh;
 *  - Notion outbox flush every minute.
 * Each uses a jobKey so overlapping triggers coalesce; the sync itself also holds an advisory lock.
 */
export const CRM_CRONTAB = [
  `*/10 * * * * crm_sync ?id=crm_sync_incremental&max=1&jobKey=crm_sync_scheduled {"mode":"incremental","trigger":"schedule"}`,
  `0 19 * * * crm_sync ?id=crm_sync_nightly&max=1&jobKey=crm_sync_nightly {"mode":"full","trigger":"nightly"}`,
  `* * * * * notion_outbox_flush ?id=notion_outbox_flush&max=1&jobKey=notion_outbox_flush`,
].join("\n");

/** M4: stale test-send claims become `unknown` (never retried). Every 5 minutes. */
export const TEST_SEND_CRONTAB = `*/5 * * * * test_send_reaper ?id=test_send_reaper&max=1&jobKey=test_send_reaper`;

/**
 * M5: every minute, stale campaign-message claims become `unknown` and every campaign that should be
 * dispatching (queued, sending, cancelling) gets a dispatcher job if it lost one (crash, restart).
 */
export const CAMPAIGN_CRONTAB = `* * * * * campaign_maintenance ?id=campaign_maintenance&max=1&jobKey=campaign_maintenance`;

/**
 * Which schedules the worker registers. Send maintenance (reapers, dispatcher sweeper) does not
 * depend on Notion. Defect found in M5: until then every schedule, including the M4 test-send
 * reaper, was registered only when NOTION_MODE was not "disabled".
 */
export function crontabFor(o: { crm: boolean; sending: boolean }): string {
  return [...(o.crm ? [CRM_CRONTAB] : []), ...(o.sending ? [TEST_SEND_CRONTAB, CAMPAIGN_CRONTAB] : [])].join("\n");
}

export const DISPATCH_JOB = "dispatch_campaign";
export const dispatchJobKey = (campaignId: string) => `dispatch:${campaignId}`;

export function makeTaskList(ctx: { workerId: string; databaseUrl: string; notionEnv?: () => NotionEnv; dispatchBudgetMs?: number }): TaskList {
  const env = () => ctx.notionEnv?.() ?? notionEnvFromConfig(getConfig());
  let runtimeMock: MockTransport | undefined;

  const systemProbe: Task = async (payload, helpers) => {
    const p = payload as SystemProbePayload;
    const log = withCorrelation({ job_id: String(helpers.job.id), task: "system_probe" });
    await getDb(ctx.databaseUrl)
      .insert(systemProbes)
      .values({
        probeId: p.probeId,
        enqueuedAt: new Date(p.enqueuedAt),
        workerId: ctx.workerId,
        jobId: String(helpers.job.id),
      })
      .onConflictDoNothing();
    log.info({ probe_id: p.probeId }, "system probe executed");
  };

  const crmSync: Task = async (payload, helpers) => {
    const p = payload as CrmSyncPayload;
    const log = withCorrelation({ job_id: String(helpers.job.id), task: "crm_sync", request_id: p.requestId });
    const r = await syncContacts(getDb(ctx.databaseUrl), env(), {
      mode: p.mode,
      trigger: p.trigger,
      actor: p.actor ?? `system:${p.trigger}`,
      correlationId: p.requestId ?? `job:${helpers.job.id}`,
      logger: log,
    });
    if (r.status === "skipped" && r.errorCode === "not_connected") log.debug("crm sync skipped: Notion not connected");
    // Push corrections (e.g. "Unsubscribed" back to Notion) promptly instead of waiting for the cron.
    if (r.counts.outboxQueued > 0) await helpers.addJob("notion_outbox_flush", {}, { jobKey: "notion_outbox_flush", maxAttempts: 1 });
  };

  const outboxFlush: Task = async (_payload, helpers) => {
    const log = withCorrelation({ job_id: String(helpers.job.id), task: "notion_outbox_flush" });
    const r = await flushOutbox(getDb(ctx.databaseUrl), env());
    if (r.claimed) log.info(r, "notion outbox flushed");
  };

  const testSendReaper: Task = async (_payload, helpers) => {
    const log = withCorrelation({ job_id: String(helpers.job.id), task: "test_send_reaper" });
    const n = await reapStaleTestSends(getDb(ctx.databaseUrl));
    if (n) log.warn({ count: n }, "stale test-send claims marked unknown (not retried)");
  };

  const dispatch: Task = async (payload, helpers) => {
    const p = payload as { campaignId: string };
    const log = withCorrelation({ job_id: String(helpers.job.id), task: DISPATCH_JOB, campaign_id: p.campaignId });
    const cfg = getConfig();
    runtimeMock ??= makeRuntimeMock(cfg);
    const r = await dispatchCampaign(getDb(ctx.databaseUrl), { cfg, workerId: ctx.workerId, mock: runtimeMock }, p.campaignId, { budgetMs: ctx.dispatchBudgetMs });
    log.info({ result: r.result, attempted: r.attempted, next_run_at: r.nextRunAt?.toISOString() }, "dispatch run finished");
    if (r.result === "continue") await helpers.addJob(DISPATCH_JOB, p, { jobKey: dispatchJobKey(p.campaignId), maxAttempts: 5 });
    else if (r.result === "waiting") await helpers.addJob(DISPATCH_JOB, p, { jobKey: dispatchJobKey(p.campaignId), runAt: r.nextRunAt, maxAttempts: 5 });
  };

  /** M6: fenced start of a scheduled campaign (payload revision must still be current). */
  const startCampaign: Task = async (payload, helpers) => {
    const p = payload as { campaignId: string; revision: number };
    const r = await startScheduled(getDb(ctx.databaseUrl), { campaignId: p.campaignId, revision: p.revision, trigger: `job:${helpers.job.id}` });
    if (r.result === "started") await helpers.addJob(DISPATCH_JOB, { campaignId: p.campaignId }, { jobKey: dispatchJobKey(p.campaignId), maxAttempts: 5 });
  };

  const campaignMaintenance: Task = async (_payload, helpers) => {
    const log = withCorrelation({ job_id: String(helpers.job.id), task: "campaign_maintenance" });
    const db = getDb(ctx.databaseUrl);
    // Sweeper: a due scheduled campaign whose start job was lost (or delayed) is started here, with the
    // same fence. Duplicate triggers are harmless: only one fenced update can succeed.
    for (const due of await dueScheduledCampaigns(db, new Date())) {
      const r = await startScheduled(db, { campaignId: due.id, revision: due.revision, trigger: "sweeper" });
      if (r.result === "started") await helpers.addJob(DISPATCH_JOB, { campaignId: due.id }, { jobKey: dispatchJobKey(due.id), maxAttempts: 5 });
    }
    const reaped = await reapStaleMessageClaims(db);
    if (reaped) log.warn({ count: reaped }, "stale campaign-message claims marked unknown (not retried)");
    for (const id of await campaignsNeedingDispatch(db)) {
      // preserve_run_at: a dispatcher waiting for a throttle backoff keeps its time; a lost one is recreated.
      await helpers.addJob(DISPATCH_JOB, { campaignId: id }, { jobKey: dispatchJobKey(id), jobKeyMode: "preserve_run_at", maxAttempts: 5 });
    }
    // Admin alerts (held / blocked) are emailed through the sending guard; never in SEND_MODE=disabled.
    const cfg = getConfig();
    runtimeMock ??= makeRuntimeMock(cfg);
    await emailPendingAlerts(db, { cfg, mock: runtimeMock });
  };

  return {
    system_probe: systemProbe,
    crm_sync: crmSync,
    notion_outbox_flush: outboxFlush,
    test_send_reaper: testSendReaper,
    [DISPATCH_JOB]: dispatch,
    start_campaign: startCampaign,
    campaign_maintenance: campaignMaintenance,
  };
}
