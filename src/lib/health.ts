import { desc, isNull, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import type { Db } from "./db/client";
import { workerHeartbeats } from "./db/schema";

export type HealthReport = {
  status: "ok" | "degraded";
  checkedAt: string;
  build: string;
  env: string;
  sendMode: string;
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    worker: { ok: boolean; lastSeenAt?: string; ageSeconds?: number; workerId?: string; error?: string };
  };
};

export async function checkHealth(
  db: Db,
  opts: { clock: Clock; build: string; env: string; sendMode: string; maxHeartbeatAgeS: number },
): Promise<HealthReport> {
  const now = opts.clock.now();
  const report: HealthReport = {
    status: "ok",
    checkedAt: now.toISOString(),
    build: opts.build,
    env: opts.env,
    sendMode: opts.sendMode,
    checks: { database: { ok: false }, worker: { ok: false } },
  };

  const t0 = performance.now();
  try {
    await db.execute(sql`select 1`);
    report.checks.database = { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch {
    // Do not leak connection strings or driver detail on a public endpoint.
    report.checks.database = { ok: false, error: "database unreachable" };
  }

  if (report.checks.database.ok) {
    try {
      const rows = await db
        .select()
        .from(workerHeartbeats)
        .where(isNull(workerHeartbeats.stoppedAt))
        .orderBy(desc(workerHeartbeats.lastSeenAt))
        .limit(1);
      const hb = rows[0];
      if (!hb) {
        report.checks.worker = { ok: false, error: "no running worker has reported a heartbeat" };
      } else {
        const ageSeconds = Math.max(0, Math.round((now.getTime() - hb.lastSeenAt.getTime()) / 1000));
        report.checks.worker = {
          ok: ageSeconds <= opts.maxHeartbeatAgeS,
          lastSeenAt: hb.lastSeenAt.toISOString(),
          ageSeconds,
          workerId: hb.workerId,
          ...(ageSeconds > opts.maxHeartbeatAgeS ? { error: `heartbeat older than ${opts.maxHeartbeatAgeS}s` } : {}),
        };
      }
    } catch {
      report.checks.worker = { ok: false, error: "heartbeat lookup failed" };
    }
  } else {
    report.checks.worker = { ok: false, error: "skipped: database unreachable" };
  }

  if (!report.checks.database.ok || !report.checks.worker.ok) report.status = "degraded";
  return report;
}
