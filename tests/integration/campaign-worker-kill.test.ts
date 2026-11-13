/**
 * R-SEND-03 with REAL processes: a worker process is hard-killed in the middle of a batch, a second
 * worker process takes over (the dispatcher job is recreated by the every-minute maintenance cron),
 * and no message is ever sent twice. The mock transport (SEND_MODE=mock, no network) appends one line
 * per provider call to a file, so calls are counted across processes. MOCK: no SES involved.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupOwned, spawnOwned } from "../../scripts/lib/owned-processes";
import { FixedClock } from "../../src/lib/clock";
import { reapStaleMessageClaims } from "../../src/lib/campaigns/dispatcher";
import { approveAndSendNow, createCampaign, reviewCampaign } from "../../src/lib/campaigns/service";
import { closeDb, getDb, type Db } from "../../src/lib/db/client";
import { campaigns, consentRecords, contacts, messages } from "../../src/lib/db/schema";
import { enqueueDispatch, releaseWorkerUtils } from "../../src/lib/jobs";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { createTestDatabase, testEnv, waitFor } from "./helpers";

const N = 40;
const dir = path.resolve(".local/test-artifacts/worker-kill");
const log1 = path.join(dir, "mock-calls-worker1.jsonl");
const log2 = path.join(dir, "mock-calls-worker2.jsonl");
let db: Db;
let url: string;
let drop: () => Promise<void>;
const pids: number[] = [];

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  const t = await createTestDatabase("m5_kill");
  url = t.url;
  drop = t.drop;
  db = getDb(url);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
afterAll(async () => {
  const r = await cleanupOwned(pids);
  expect(r.survivors).toEqual([]);
  await releaseWorkerUtils();
  await closeDb();
  await drop();
});

function startWorker(name: string, extra: Record<string, string>) {
  const env = {
    ...process.env,
    ...testEnv(url, { SEND_MODE: "mock", NOTION_MODE: "disabled", WORKER_CONCURRENCY: "1", HEARTBEAT_INTERVAL_MS: "1000", ...extra }),
  };
  const child = spawnOwned(name, process.execPath, ["--import", "tsx", "src/worker/main.ts"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  pids.push(child.pid!);
  return { child, stderr: () => stderr };
}

const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { messageId: string; pid: number }) : []);

describe("worker killed mid-batch (real processes)", () => {
  it("R-SEND-03: no message is re-sent; interrupted claims become unknown; the rest completes after restart", { timeout: 240_000 }, async () => {
    const r = await importTemplate(db, { name: "Kill test", html: '<p>Chào {{ greeting_name | default: "bạn" }}</p><a href="{{ unsubscribe_url }}">Hủy</a>', sourceKind: "paste", actor: "test" });
    const v = await saveSubject(db, { templateId: r.template.id, baseVersionId: r.version.id, subject: "[QC] Kill test", actor: "test" });
    const rows = Array.from({ length: N }, (_, i) => ({ notionPageId: `kill-${i}`, fullName: `K ${i}`, email: `kill-${i}@example.com`, emailNormalized: `kill-${i}@example.com`, emailStatus: "valid" as const, tags: ["kill"] }));
    await db.insert(contacts).values(rows);
    await db.insert(consentRecords).values(rows.map((x) => ({ emailNormalized: x.emailNormalized, purpose: "marketing_email" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "TEST" })));
    const c = await createCampaign(db, { name: "Kill", templateId: r.template.id, templateVersionId: v.id, audience: { kind: "tags", tags: ["kill"] }, actor: "user:test" });
    const cfg = { APP_ENV: "test" as const, SEND_MODE: "mock" as const, TEST_RECIPIENT_ALLOWLIST: [], SEND_AUTHORIZATION_REF: undefined, SES_FROM_ADDRESS: undefined };
    const rev = await reviewCampaign(db, cfg, c.id);
    expect(rev.blocking).toEqual([]);
    await approveAndSendNow(db, { cfg, enqueue: (id) => enqueueDispatch(id, url) }, { campaignId: c.id, expectedRevision: rev.campaign.scheduleRevision, expectedRecipients: N, actor: "user:test" });

    // Worker 1: slow mock sends (300 ms each); kill it hard after a few calls.
    const w1 = startWorker("worker-1", { MOCK_TRANSPORT_LOG: log1, MOCK_SEND_DELAY_MS: "300" });
    await waitFor(async () => lines(log1).length >= 6, 60_000, 50);
    const exited = new Promise((res) => w1.child.once("exit", res));
    w1.child.kill("SIGKILL");
    await exited;

    const afterKill = await db.select().from(messages).where(eq(messages.campaignId, c.id));
    const claimed = afterKill.filter((m) => m.sendStatus === "claimed").map((m) => m.id);
    const sentBefore = afterKill.filter((m) => m.sendStatus === "sent").length;
    expect(claimed.length).toBeGreaterThan(0); // the kill really happened mid-batch
    expect(sentBefore).toBeGreaterThan(0);

    // Ten minutes later (controlled clock), the reaper turns the interrupted claims into `unknown`.
    expect(await reapStaleMessageClaims(db, new FixedClock(new Date(Date.now() + 11 * 60_000)))).toBe(claimed.length);

    // Worker 2: the maintenance cron recreates the dispatcher job (the old one is still locked by the dead worker).
    const w2 = startWorker("worker-2", { MOCK_TRANSPORT_LOG: log2 });
    const done = await waitFor(
      async () => {
        const s = (await db.select().from(campaigns).where(eq(campaigns.id, c.id)))[0].status;
        return s === "completed" || s === "completed_with_issues" ? s : null;
      },
      150_000,
      500,
    ).catch((e) => {
      throw new Error(`${e}\nworker-2 stderr:\n${w2.stderr().slice(-2000)}`);
    });
    expect(done).toBe("completed_with_issues");

    const final = await db.select().from(messages).where(eq(messages.campaignId, c.id));
    const unknown = final.filter((m) => m.sendStatus === "unknown").map((m) => m.id).sort();
    expect(unknown).toEqual([...claimed].sort());
    expect(final.filter((m) => m.sendStatus === "sent").length).toBe(N - claimed.length);

    const calls = [...lines(log1), ...lines(log2)];
    const counts = new Map<string, number>();
    for (const l of calls) counts.set(l.messageId, (counts.get(l.messageId) ?? 0) + 1);
    expect([...counts.values()].filter((k) => k > 1)).toEqual([]); // no message sent twice, across processes
    expect(lines(log2).some((l) => unknown.includes(l.messageId))).toBe(false); // uncertain ones were not retried
    // Every message that is `sent` was called exactly once.
    for (const m of final.filter((x) => x.sendStatus === "sent")) expect(counts.get(m.id)).toBe(1);
  });
});
