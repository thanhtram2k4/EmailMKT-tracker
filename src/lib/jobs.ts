import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";

/**
 * Job queue helpers for the web app and scripts. Correctness-critical jobs (from M5/M6)
 * must not rely on queue de-duplication alone — they re-check state in the database
 * (fenced conditional updates) when they run.
 */
const holder = ((globalThis as Record<string, unknown>).__emtJobs ??= {}) as { utils?: Promise<WorkerUtils>; url?: string };

export function getWorkerUtils(databaseUrl = process.env.DATABASE_URL!): Promise<WorkerUtils> {
  if (!holder.utils || holder.url !== databaseUrl) {
    holder.url = databaseUrl;
    holder.utils = makeWorkerUtils({ connectionString: databaseUrl });
  }
  return holder.utils;
}

export async function releaseWorkerUtils() {
  const u = holder.utils;
  holder.utils = undefined;
  holder.url = undefined;
  if (u) await (await u).release();
}
