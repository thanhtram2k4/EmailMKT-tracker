/**
 * M1 acceptance: "The worker runs a test job after a restart."
 * Jobs are queued while NO worker is running, then a worker is started; the job must run.
 * Then the worker is stopped, another job is queued, and a *new* worker process instance
 * (restart) must pick it up. Heartbeat/health behaviour is checked along the way.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock, systemClock } from "../../src/lib/clock";
import { closeDb, getDb } from "../../src/lib/db/client";
import { systemProbes, workerHeartbeats } from "../../src/lib/db/schema";
import { checkHealth } from "../../src/lib/health";
import { getWorkerUtils, releaseWorkerUtils } from "../../src/lib/jobs";
import { startWorker, type WorkerHandle } from "../../src/worker/runner";
import { createTestDatabase, waitFor } from "./helpers";

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
const handles: WorkerHandle[] = [];

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  tdb = await createTestDatabase("it_worker");
});
afterAll(async () => {
  for (const h of handles) await h.stop();
  await releaseWorkerUtils();
  await closeDb();
  await tdb.drop();
});

async function enqueueProbe() {
  const probeId = randomUUID();
  const utils = await getWorkerUtils(tdb.url);
  await utils.addJob("system_probe", { probeId, enqueuedAt: new Date().toISOString() });
  return probeId;
}

const probeRow = (probeId: string) => async () =>
  (await getDb(tdb.url).select().from(systemProbes).where(eq(systemProbes.probeId, probeId)))[0];

const health = (clock = systemClock) =>
  checkHealth(getDb(tdb.url), { clock, build: "test", env: "test", sendMode: "disabled", maxHeartbeatAgeS: 60 });

describe("background worker", () => {
  it("reports degraded health when no worker has ever run", async () => {
    const h = await health();
    expect(h.checks.database.ok).toBe(true);
    expect(h.checks.worker.ok).toBe(false);
    expect(h.status).toBe("degraded");
  });

  it("runs a job that was queued while no worker was running", async () => {
    const probeId = await enqueueProbe();
    await new Promise((r) => setTimeout(r, 500));
    expect(await probeRow(probeId)()).toBeUndefined(); // nothing ran it yet

    const w1 = await startWorker({ databaseUrl: tdb.url, concurrency: 1, heartbeatIntervalMs: 1000, buildId: "test", workerId: "w1", pollIntervalMs: 200 });
    handles.push(w1);
    const row = await waitFor(probeRow(probeId));
    expect(row.workerId).toBe("w1");

    const h = await health();
    expect(h.status).toBe("ok");
    expect(h.checks.worker.workerId).toBe("w1");
  });

  it("runs a job queued during downtime after a worker restart", async () => {
    const w1 = handles.pop()!;
    await w1.stop();
    const hb = (await getDb(tdb.url).select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, "w1")))[0];
    expect(hb.stoppedAt).not.toBeNull();
    expect((await health()).checks.worker.ok).toBe(false); // stopped worker no longer counts

    const probeId = await enqueueProbe();
    await new Promise((r) => setTimeout(r, 500));
    expect(await probeRow(probeId)()).toBeUndefined();

    const w2 = await startWorker({ databaseUrl: tdb.url, concurrency: 1, heartbeatIntervalMs: 1000, buildId: "test", workerId: "w2", pollIntervalMs: 200 });
    handles.push(w2);
    const row = await waitFor(probeRow(probeId));
    expect(row.workerId).toBe("w2");
  });

  it("executes each queued job once even with two workers running", async () => {
    const w3 = await startWorker({ databaseUrl: tdb.url, concurrency: 2, heartbeatIntervalMs: 1000, buildId: "test", workerId: "w3", pollIntervalMs: 200 });
    handles.push(w3);
    const ids = await Promise.all(Array.from({ length: 20 }, () => enqueueProbe()));
    await waitFor(async () => {
      const rows = await getDb(tdb.url).select().from(systemProbes);
      return ids.every((id) => rows.some((r) => r.probeId === id));
    });
    // system_probes.probe_id is the primary key and the task uses ON CONFLICT DO NOTHING,
    // so count job executions through graphile_worker instead: no job left, none failed.
    // M8 fix (race found on a slow run): a task writes its probe row BEFORE Graphile Worker deletes the
    // finished job, so wait for the queue to drain — but fail on any retried or failed job.
    const pool = (await import("../../src/lib/db/client")).getPool(tdb.url);
    const failed = await pool.query("select count(*)::int as n from graphile_worker.jobs where attempts > 1 or last_error is not null");
    expect(failed.rows[0].n).toBe(0);
    await waitFor(async () => (await pool.query("select count(*)::int as n from graphile_worker.jobs")).rows[0].n === 0, 10_000);
  });

  it("flags a stale heartbeat as degraded (controlled clock)", async () => {
    const future = new FixedClock(new Date(Date.now() + 5 * 60_000));
    const h = await health(future);
    expect(h.checks.worker.ok).toBe(false);
    expect(h.checks.worker.error).toMatch(/older than 60s/);
  });
});
