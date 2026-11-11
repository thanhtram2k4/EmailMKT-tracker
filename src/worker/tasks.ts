import type { Task, TaskList } from "graphile-worker";
import { getDb } from "../lib/db/client";
import { systemProbes } from "../lib/db/schema";
import { withCorrelation } from "../lib/logger";

export type SystemProbePayload = { probeId: string; enqueuedAt: string };

export function makeTaskList(ctx: { workerId: string; databaseUrl: string }): TaskList {
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

  return { system_probe: systemProbe };
}
