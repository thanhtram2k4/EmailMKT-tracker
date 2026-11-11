import type { Task, TaskList } from "graphile-worker";
import { getConfig } from "../lib/config";
import { flushOutbox } from "../lib/crm/outbox";
import { notionEnvFromConfig, type NotionEnv } from "../lib/crm/notion-env";
import { syncContacts, type SyncMode, type SyncTrigger } from "../lib/crm/sync";
import { getDb } from "../lib/db/client";
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

export function makeTaskList(ctx: { workerId: string; databaseUrl: string; notionEnv?: () => NotionEnv }): TaskList {
  const env = () => ctx.notionEnv?.() ?? notionEnvFromConfig(getConfig());

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

  return { system_probe: systemProbe, crm_sync: crmSync, notion_outbox_flush: outboxFlush };
}
