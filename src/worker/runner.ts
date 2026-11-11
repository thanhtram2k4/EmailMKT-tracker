/**
 * Background worker: Graphile Worker job runner + heartbeat.
 * Runs as its own always-on process (`npm run worker`), separate from the web app,
 * so queued and scheduled work continues when no browser or user computer is involved.
 */
import { Logger, run, type Runner } from "graphile-worker";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { eq } from "drizzle-orm";
import { systemClock, type Clock } from "../lib/clock";
import { getDb } from "../lib/db/client";
import { workerHeartbeats } from "../lib/db/schema";
import { getLogger } from "../lib/logger";
import type { NotionEnv } from "../lib/crm/notion-env";
import { CRM_CRONTAB, makeTaskList } from "./tasks";

export type WorkerHandle = { workerId: string; runner: Runner; stop: () => Promise<void> };

export async function startWorker(opts: {
  databaseUrl: string;
  concurrency: number;
  heartbeatIntervalMs: number;
  buildId: string;
  clock?: Clock;
  workerId?: string;
  pollIntervalMs?: number;
  /** Register the CRM cron schedules (sync every 10 min, nightly full, outbox every minute). */
  enableCrmSchedules?: boolean;
  notionEnv?: () => NotionEnv;
}): Promise<WorkerHandle> {
  const clock = opts.clock ?? systemClock;
  const workerId = opts.workerId ?? `worker-${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const log = getLogger().child({ worker_id: workerId });
  const db = getDb(opts.databaseUrl);

  const now = clock.now();
  await db
    .insert(workerHeartbeats)
    .values({
      workerId,
      hostname: os.hostname(),
      pid: String(process.pid),
      buildId: opts.buildId,
      startedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: now, stoppedAt: null } });

  const beat = async () => {
    try {
      await db.update(workerHeartbeats).set({ lastSeenAt: clock.now() }).where(eq(workerHeartbeats.workerId, workerId));
    } catch (err) {
      log.error({ err }, "heartbeat update failed");
    }
  };
  const timer = setInterval(beat, opts.heartbeatIntervalMs);
  timer.unref();

  const gwLogger = new Logger((scope) => (level, message, meta) => {
    const lvl = level === "warning" ? "warn" : level === "error" ? "error" : level === "debug" ? "debug" : "info";
    log[lvl]({ gw: scope, ...(meta ?? {}) }, message);
  });

  const runner = await run({
    connectionString: opts.databaseUrl,
    concurrency: opts.concurrency,
    noHandleSignals: true,
    pollInterval: opts.pollIntervalMs ?? 2000,
    logger: gwLogger,
    taskList: makeTaskList({ workerId, databaseUrl: opts.databaseUrl, notionEnv: opts.notionEnv }),
    ...(opts.enableCrmSchedules ? { crontab: CRM_CRONTAB } : {}),
  });
  log.info({ concurrency: opts.concurrency }, "worker started");

  let stopped = false;
  return {
    workerId,
    runner,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await runner.stop();
      await db.update(workerHeartbeats).set({ stoppedAt: clock.now() }).where(eq(workerHeartbeats.workerId, workerId));
      log.info("worker stopped");
    },
  };
}
