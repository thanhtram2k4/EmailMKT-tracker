/**
 * M6 integration tests: scheduling against REAL PostgreSQL with a controlled clock, the MOCK transport
 * or a FAKE SES client (no network, no AWS). IDs refer to docs/PLAN.md "Scheduling regression".
 */
import { GetAccountCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/lib/clock";
import { resetConfigCache } from "../../src/lib/config";
import { closeDb, getDb, type Db } from "../../src/lib/db/client";
import { adminAlerts, campaigns, campaignSnapshots, campaignTransitions, consentRecords, contacts, messages, staffAllowlist } from "../../src/lib/db/schema";
import { acknowledgeAlert, emailPendingAlerts, type AlertMailConfig } from "../../src/lib/campaigns/alerts";
import { dispatchCampaign, RateLimiter, type DispatchConfig, type DispatchDeps } from "../../src/lib/campaigns/dispatcher";
import { dueScheduledCampaigns, rescheduleCampaign, scheduleCampaign, sendOverdueNow, startScheduled, unscheduleToDraft } from "../../src/lib/campaigns/schedule";
import { localParts } from "../../src/lib/campaigns/schedule-time";
import { cancelCampaign, CampaignError, createCampaign, resumeCampaign, reviewCampaign, updateDraft, type CampaignConfig, type CampaignDeps } from "../../src/lib/campaigns/service";
import { messageCounts } from "../../src/lib/campaigns/state";
import { unsubscribeByToken } from "../../src/lib/campaigns/unsubscribe";
import { releaseWorkerUtils, removeStartJob, scheduleStartJob } from "../../src/lib/jobs";
import { MockTransport, type OutboundMessage, type SendResult } from "../../src/lib/sending/transport";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { startWorker, type WorkerHandle } from "../../src/worker/runner";
import { createTestDatabase, testEnv, waitFor } from "./helpers";

type Cfg = DispatchConfig & CampaignConfig;
const cfg = (over: Partial<Cfg> = {}): Cfg => ({
  APP_ENV: "test",
  SEND_MODE: "mock",
  TEST_RECIPIENT_ALLOWLIST: [],
  SEND_AUTHORIZATION_REF: undefined,
  SES_REGION: "ap-southeast-1",
  SES_FROM_ADDRESS: undefined,
  SES_CONFIGURATION_SET: undefined,
  SES_TIMEOUT_MS: 1000,
  trackingBaseUrl: "http://localhost:3999",
  ...over,
});
const HCM = "Asia/Ho_Chi_Minh";
const ADMIN = "user:admin-test";
const HTML = '<p>Chào {{ greeting_name | default: "Quý khách" }}</p><p><a href="{{ unsubscribe_url }}">Hủy đăng ký</a></p>';

let db: Db;
let url: string;
let drop: () => Promise<void>;
let templateId: string;
let versionId: string;
const workers: WorkerHandle[] = [];

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  const t = await createTestDatabase("m6_schedule");
  url = t.url;
  drop = t.drop;
  db = getDb(url);
  const r = await importTemplate(db, { name: "Lịch gửi", html: HTML, sourceKind: "paste", actor: "test" });
  const v = await saveSubject(db, { templateId: r.template.id, baseVersionId: r.version.id, subject: '[QC] Chào {{ greeting_name | default: "bạn" }}', actor: "test" });
  templateId = r.template.id;
  versionId = v.id;
  await db.insert(staffAllowlist).values({ email: "admin@example.com", role: "admin", addedBy: "test" });
});
afterAll(async () => {
  for (const w of workers) await w.stop();
  await releaseWorkerUtils();
  await closeDb();
  await drop();
});

const addr = (p: string, i: number) => `${p}-${i}@example.com`;
async function newCampaign(prefix: string, n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ notionPageId: `page-${prefix}-${i}`, fullName: `Người ${i}`, greetingName: `Anh ${i}`, email: addr(prefix, i), emailNormalized: addr(prefix, i), emailStatus: "valid" as const, tags: [prefix] }));
  await db.insert(contacts).values(rows);
  await db.insert(consentRecords).values(rows.map((r) => ({ emailNormalized: r.emailNormalized, purpose: "marketing_email" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "TEST" })));
  return createCampaign(db, { name: `Lịch ${prefix}`, templateId, templateVersionId: versionId, audience: { kind: "tags", tags: [prefix] }, actor: ADMIN });
}

type Rec = { starts: Array<[string, number, Date]>; removed: string[]; enqueued: string[] };
function deps(clock: FixedClock, rec: Rec = { starts: [], removed: [], enqueued: [] }, c: Cfg = cfg()): CampaignDeps & { rec: Rec } {
  return {
    cfg: c,
    clock,
    rec,
    enqueue: async (id) => void rec.enqueued.push(id),
    scheduleStart: async (id, rev, at) => void rec.starts.push([id, rev, at]),
    removeStart: async (id) => void rec.removed.push(id),
  };
}

/** Schedule a draft for the minute-aligned UTC instant `at` (validation clock 5 minutes earlier). */
async function scheduleAt(id: string, at: Date, d = deps(new FixedClock(new Date(at.getTime() - 5 * 60_000))), zone = HCM) {
  const r = await reviewCampaign(db, d.cfg, id);
  expect(r.blocking).toEqual([]);
  const { date, time } = localParts(at, zone);
  await scheduleCampaign(db, d, { campaignId: id, expectedRevision: r.campaign.scheduleRevision, expectedRecipients: r.resolved.included.length, actor: ADMIN, date, time, zone });
  return d;
}

const minute = (ms: number) => new Date(Math.ceil(ms / 60_000) * 60_000);
const T = () => minute(Date.now() + 10 * 60_000); // a future minute boundary
const at = (base: Date, deltaMs: number) => new FixedClock(new Date(base.getTime() + deltaMs));
const campaign = async (id: string) => (await db.select().from(campaigns).where(eq(campaigns.id, id)))[0];
const transitions = (id: string) => db.select().from(campaignTransitions).where(eq(campaignTransitions.campaignId, id)).orderBy(campaignTransitions.id);
class FastLimiter extends RateLimiter {
  constructor() {
    super(100_000);
  }
  override setRate() {}
}
/** The dispatcher runs on a controlled clock past every scheduled time used here (approval also ran on a controlled clock). */
const AFTER_ALL = () => new FixedClock(new Date(Date.now() + 24 * 3600_000));
const dispatchDeps = (mock: MockTransport, over: Partial<DispatchDeps> = {}): DispatchDeps => ({ cfg: cfg(), workerId: "w", mock, limiter: new FastLimiter(), clock: AFTER_ALL(), ...over });
async function drive(id: string, d: DispatchDeps) {
  for (let k = 0; k < 50; k++) {
    const r = await dispatchCampaign(db, d, id, { budgetMs: 10_000 });
    if (r.result !== "continue") return r;
  }
  throw new Error("did not settle");
}
async function dbError(p: PromiseLike<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return String(err.cause?.message ?? err.message);
  }
  return "(no error)";
}

describe("scheduling a campaign", () => {
  it("R-SCH-04 (service): past, too-soon, nonexistent and ambiguous times are refused; nothing is frozen", async () => {
    const c = await newCampaign("val", 2);
    const r = await reviewCampaign(db, cfg(), c.id);
    const base = { campaignId: c.id, expectedRevision: r.campaign.scheduleRevision, expectedRecipients: 2, actor: ADMIN };
    const now = new Date("2026-03-01T00:00:00Z");
    const d = deps(new FixedClock(now));
    await expect(scheduleCampaign(db, d, { ...base, date: "2026-02-28", time: "09:00", zone: HCM })).rejects.toThrow(/in the past/);
    await expect(scheduleCampaign(db, d, { ...base, date: "2026-03-01", time: "07:01", zone: HCM })).rejects.toThrow(/at least 2 minutes/);
    await expect(scheduleCampaign(db, d, { ...base, date: "2026-03-08", time: "02:30", zone: "America/New_York" })).rejects.toThrow(/does not exist/);
    const amb = await scheduleCampaign(db, d, { ...base, date: "2026-11-01", time: "01:30", zone: "America/New_York" }).catch((e) => e as CampaignError);
    expect(amb).toBeInstanceOf(CampaignError);
    expect((amb as CampaignError).details).toEqual(["2026-11-01 01:30 UTC-04:00 = 05:30 UTC, 1 Nov 2026", "2026-11-01 01:30 UTC-05:00 = 06:30 UTC, 1 Nov 2026"]);
    await expect(scheduleCampaign(db, d, { ...base, date: "2026-03-01", time: "09:00", zone: "Mars/Olympus" })).rejects.toThrow(/time zone/);
    expect((await campaign(c.id)).status).toBe("draft");
    expect(await db.select().from(campaignSnapshots).where(eq(campaignSnapshots.campaignId, c.id))).toHaveLength(0);
    // The ambiguous time with an explicit offset is accepted and stored with that offset.
    await scheduleCampaign(db, d, { ...base, date: "2026-11-01", time: "01:30", zone: "America/New_York", offsetMinutes: -300 });
    expect(await campaign(c.id)).toMatchObject({ status: "scheduled", scheduleTz: "America/New_York", scheduleLocal: "2026-11-01 01:30", scheduleOffsetMinutes: -300, scheduledAtUtc: new Date("2026-11-01T06:30:00Z") });
  });

  it("stores UTC + zone + local time, freezes the snapshot, and places the start job (revision in the payload)", async () => {
    const c = await newCampaign("sch", 3);
    const when = new Date("2026-11-20T02:00:00Z"); // 09:00 in Ho Chi Minh
    const d = await scheduleAt(c.id, when);
    const row = await campaign(c.id);
    expect(row).toMatchObject({ status: "scheduled", scheduledAtUtc: when, scheduleTz: HCM, scheduleLocal: "2026-11-20 09:00", scheduleOffsetMinutes: 420, scheduledBy: ADMIN });
    expect(row.snapshotId).not.toBeNull();
    expect(d.rec.starts).toEqual([[c.id, row.scheduleRevision, when]]);
    expect(await messageCounts(db, c.id)).toMatchObject({ total: 3, pending: 3 });
    const tr = await transitions(c.id);
    expect(tr.at(-1)).toMatchObject({ fromStatus: "draft", toStatus: "scheduled", actor: ADMIN });
    expect(tr.at(-1)!.reason).toContain("2026-11-20 09:00 (Asia/Ho_Chi_Minh, UTC+07:00) = 02:00 UTC");
  });
});

describe("fenced start (controlled clock)", () => {
  it("R-SCH-05/06: no early dispatch at T−1 s; starts at T with the delay recorded", async () => {
    const c = await newCampaign("early", 2);
    const t = T();
    await scheduleAt(c.id, t);
    expect(await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "test" }, { clock: at(t, -1000) })).toEqual({ result: "early" });
    expect((await campaign(c.id)).status).toBe("scheduled");
    expect(await dueScheduledCampaigns(db, at(t, -1000).now())).not.toContainEqual(expect.objectContaining({ id: c.id }));
    expect(await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "test" }, { clock: at(t, 500) })).toEqual({ result: "started", delayMs: 500 });
    expect(await campaign(c.id)).toMatchObject({ status: "queued", startDelayMs: 500, processingStartedAt: new Date(t.getTime() + 500) });
    expect((await transitions(c.id)).at(-1)!.reason).toMatch(/^scheduled start/);
  });

  it("R-SCH-07: reschedule increments the revision; the old job is stale, only the new one starts; one job per campaign", async () => {
    const c = await newCampaign("resch", 2);
    const t1 = T();
    const realJobs = { ...deps(at(t1, -5 * 60_000)), scheduleStart: (id: string, rev: number, runAt: Date) => scheduleStartJob(id, rev, runAt, url) };
    await scheduleAt(c.id, t1, realJobs);
    const t2 = new Date(t1.getTime() + 30 * 60_000);
    const { date, time } = localParts(t2, HCM);
    await rescheduleCampaign(db, realJobs, { campaignId: c.id, actor: ADMIN, date, time, zone: HCM });
    expect(await campaign(c.id)).toMatchObject({ status: "scheduled", scheduleRevision: 1, scheduledAtUtc: t2 });
    const jobs = await db.execute(sql`select payload, run_at from graphile_worker._private_jobs where key = ${`start:${c.id}`}`);
    expect(jobs.rows).toHaveLength(1);
    expect((jobs.rows[0] as { payload: { revision: number } }).payload.revision).toBe(1);
    expect(new Date((jobs.rows[0] as { run_at: string }).run_at).getTime()).toBe(t2.getTime());
    // The old revision's job (if it still fired) fails the fence, even at the new time.
    expect(await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "old-job" }, { clock: at(t2, 1000) })).toEqual({ result: "stale" });
    expect(await startScheduled(db, { campaignId: c.id, revision: 1, trigger: "job" }, { clock: at(t2, 1000) })).toMatchObject({ result: "started" });
    expect((await transitions(c.id)).filter((x) => x.toStatus === "scheduled").map((x) => x.reason)).toEqual([expect.stringContaining("scheduled for"), expect.stringContaining("rescheduled to")]);
  });

  it("R-SCH-08: cancel before T → never dispatched; the start job is removed", async () => {
    const c = await newCampaign("cxl", 3);
    const t = T();
    const real = { ...deps(at(t, -5 * 60_000)), scheduleStart: (id: string, rev: number, runAt: Date) => scheduleStartJob(id, rev, runAt, url), removeStart: (id: string) => removeStartJob(id, url) };
    await scheduleAt(c.id, t, real);
    await cancelCampaign(db, real, { campaignId: c.id, actor: ADMIN });
    expect(await campaign(c.id)).toMatchObject({ status: "cancelled" });
    expect(await messageCounts(db, c.id)).toMatchObject({ total: 3, cancelled: 3, sent: 0 });
    expect((await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where key = ${`start:${c.id}`}`)).rows[0]).toEqual({ n: 0 });
    expect(await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "job" }, { clock: at(t, 1000) })).toEqual({ result: "not_scheduled" });
    const mock = new MockTransport();
    expect((await drive(c.id, dispatchDeps(mock))).result).toBe("inactive");
    expect(mock.calls).toHaveLength(0);
  });

  it("R-SCH-09: cancel at the moment of dispatch → one consistent outcome; in-flight sends reported", async () => {
    const c = await newCampaign("race", 20);
    const t = T();
    await scheduleAt(c.id, t);
    // Start and cancel race each other at T.
    const [s] = await Promise.all([startScheduled(db, { campaignId: c.id, revision: 0, trigger: "job" }, { clock: at(t, 10) }), cancelCampaign(db, deps(at(t, 10)), { campaignId: c.id, actor: ADMIN })]);
    let cancelledDuringSend = false;
    const mock = new MockTransport(async (m: OutboundMessage): Promise<SendResult> => ({ kind: "accepted", providerMessageId: `p-${m.messageId}` }));
    const r = await drive(c.id, dispatchDeps(mock));
    const final = await campaign(c.id);
    expect(final.status).toBe("cancelled");
    const k = await messageCounts(db, c.id);
    expect(k.claimed + k.pending).toBe(0);
    expect(k.sent + k.cancelled).toBe(20);
    expect(k.sent).toBe(mock.calls.length);
    expect(["started", "not_scheduled"]).toContain(s.result);
    expect(["cancelled", "inactive"]).toContain(r.result);
    // Second shape: the dispatcher is already sending when the cancel lands.
    const c2 = await newCampaign("race2", 30);
    await scheduleAt(c2.id, t);
    await startScheduled(db, { campaignId: c2.id, revision: 0, trigger: "job" }, { clock: at(t, 10) });
    const mock2 = new MockTransport(async (m: OutboundMessage) => {
      if (mock2.calls.length === 5 && !cancelledDuringSend) {
        cancelledDuringSend = true;
        await cancelCampaign(db, deps(at(t, 20)), { campaignId: c2.id, actor: ADMIN });
      }
      return { kind: "accepted", providerMessageId: `p-${m.messageId}` };
    });
    expect((await drive(c2.id, dispatchDeps(mock2))).result).toBe("cancelled");
    const k2 = await messageCounts(db, c2.id);
    expect(k2).toMatchObject({ sent: 5, cancelled: 25, claimed: 0, pending: 0 });
    expect((await transitions(c2.id)).at(-1)!.reason).toBe("cancelled: 5 sent, 0 uncertain, 25 not sent");
  });

  it("R-SCH-10: an edit after scheduling returns to draft with a new revision; a new snapshot is required", async () => {
    const c = await newCampaign("edit", 3);
    const t = T();
    const d = await scheduleAt(c.id, t);
    const firstSnap = (await campaign(c.id)).snapshotId;
    await unscheduleToDraft(db, d, { campaignId: c.id, actor: ADMIN });
    const row = await campaign(c.id);
    expect(row).toMatchObject({ status: "draft", scheduleRevision: 1, snapshotId: null, scheduledAtUtc: null, scheduleTz: null });
    expect(d.rec.removed).toEqual([c.id]);
    expect((await transitions(c.id)).at(-1)!.reason).toBe("Schedule removed — review and confirm again");
    expect(await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "old-job" }, { clock: at(t, 1000) })).toEqual({ result: "not_scheduled" });
    const old = await db.select().from(messages).where(eq(messages.snapshotId, firstSnap!));
    expect(old.every((m) => m.sendStatus === "cancelled")).toBe(true);
    // Editable again, and scheduling again freezes a NEW snapshot; counts show only the new one.
    await updateDraft(db, { campaignId: c.id, name: "Đã sửa", actor: ADMIN });
    await scheduleAt(c.id, new Date(t.getTime() + 60 * 60_000));
    const again = await campaign(c.id);
    expect(again.snapshotId).not.toBe(firstSnap);
    expect(await db.select().from(campaignSnapshots).where(eq(campaignSnapshots.campaignId, c.id))).toHaveLength(2);
    expect(await messageCounts(db, c.id)).toMatchObject({ total: 3, pending: 3, cancelled: 0 });
    // The snapshot still cannot be swapped any other way (DB guard).
    expect(await dbError(db.update(campaigns).set({ snapshotId: firstSnap }).where(eq(campaigns.id, c.id)))).toMatch(/cannot be changed/);
    expect(await dbError(db.update(campaigns).set({ scheduleTz: null }).where(eq(campaigns.id, c.id)))).toMatch(/needs an approved snapshot, a UTC time and a time zone/);
  });

  it("R-SCH-11/12: frozen values are used; a recipient who unsubscribes before T is skipped", async () => {
    const c = await newCampaign("frozen", 3);
    const t = T();
    await scheduleAt(c.id, t);
    await db.update(contacts).set({ greetingName: "Chị Mới" }).where(eq(contacts.notionPageId, "page-frozen-0"));
    const tok = (await db.select().from(messages).where(and(eq(messages.campaignId, c.id), eq(messages.emailNormalized, addr("frozen", 1)))))[0].trackingToken;
    await unsubscribeByToken(db, tok, { method: "one_click" });
    await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "job" }, { clock: at(t, 100) });
    const mock = new MockTransport();
    expect((await drive(c.id, dispatchDeps(mock))).result).toBe("completed");
    expect(mock.calls.map((m) => m.to).sort()).toEqual([addr("frozen", 0), addr("frozen", 2)]);
    expect(mock.calls.find((m) => m.to === addr("frozen", 0))!.subject).toBe("[QC] Chào Anh 0");
    expect(await messageCounts(db, c.id)).toMatchObject({ sent: 2, skipped: 1 });
  });

  it("R-SCH-13: duplicate triggers and sweeper overlap start the campaign exactly once", async () => {
    const c = await newCampaign("dup", 2);
    const t = T();
    await scheduleAt(c.id, t);
    const clock = at(t, 2000);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, k) => startScheduled(db, { campaignId: c.id, revision: 0, trigger: `job-${k}` }, { clock })),
      ...Array.from({ length: 3 }, () => startScheduled(db, { campaignId: c.id, trigger: "sweeper" }, { clock })),
    ]);
    expect(results.filter((r) => r.result === "started")).toHaveLength(1);
    expect(results.filter((r) => r.result !== "started").every((r) => r.result === "not_scheduled")).toBe(true);
    expect((await transitions(c.id)).filter((x) => x.fromStatus === "scheduled" && x.toStatus === "queued")).toHaveLength(1);
  });

  it("R-SCH-15: within the grace period it starts late with the delay logged; beyond it is held, not sent, and admins are alerted", async () => {
    const late = await newCampaign("late", 2);
    const t = T();
    await scheduleAt(late.id, t);
    expect(await startScheduled(db, { campaignId: late.id, revision: 0, trigger: "sweeper" }, { clock: at(t, 10 * 60_000) })).toEqual({ result: "started", delayMs: 600_000 });
    const tr = (await transitions(late.id)).at(-1)!;
    expect(tr.reason).toMatch(/late start: 600 s after the scheduled time, within the 30-minute grace period \(sweeper\)/);
    expect(tr.detail).toMatchObject({ delayMs: 600_000, zone: HCM });

    const held = await newCampaign("held", 2);
    await scheduleAt(held.id, t);
    expect(await startScheduled(db, { campaignId: held.id, revision: 0, trigger: "sweeper" }, { clock: at(t, 31 * 60_000) })).toEqual({ result: "held_overdue", delayMs: 31 * 60_000 });
    const h = await campaign(held.id);
    expect(h.status).toBe("held_overdue");
    expect(h.holdReason).toMatch(/beyond the 30-minute grace period/);
    const mock = new MockTransport();
    expect((await drive(held.id, dispatchDeps(mock))).result).toBe("inactive"); // nothing is sent while held
    expect(mock.calls).toHaveLength(0);
    const alert = (await db.select().from(adminAlerts).where(eq(adminAlerts.campaignId, held.id)))[0];
    expect(alert).toMatchObject({ kind: "held_overdue", emailStatus: "pending" });

    // Admin decisions: send now / reschedule / cancel.
    const d = deps(at(t, 32 * 60_000));
    await sendOverdueNow(db, d, { campaignId: held.id, actor: ADMIN });
    expect(d.rec.enqueued).toEqual([held.id]);
    expect((await drive(held.id, dispatchDeps(mock))).result).toBe("completed");
    expect(mock.calls).toHaveLength(2);

    const held2 = await newCampaign("held2", 1);
    await scheduleAt(held2.id, t);
    await startScheduled(db, { campaignId: held2.id, revision: 0, trigger: "sweeper" }, { clock: at(t, 45 * 60_000) });
    const t3 = new Date(t.getTime() + 120 * 60_000);
    await rescheduleCampaign(db, deps(at(t, 46 * 60_000)), { campaignId: held2.id, actor: ADMIN, ...localParts(t3, HCM), zone: HCM });
    expect(await campaign(held2.id)).toMatchObject({ status: "scheduled", scheduleRevision: 1, holdReason: null });

    const held3 = await newCampaign("held3", 1);
    await scheduleAt(held3.id, t);
    await startScheduled(db, { campaignId: held3.id, revision: 0, trigger: "sweeper" }, { clock: at(t, 45 * 60_000) });
    await cancelCampaign(db, deps(at(t, 46 * 60_000)), { campaignId: held3.id, actor: ADMIN });
    expect(await campaign(held3.id)).toMatchObject({ status: "cancelled" });
  });

  it("R-SCH-16: at execution, invalid credentials → blocked with a reason and an alert; recovery never repeats an uncertain send", async () => {
    const c = await newCampaign("exec", 3);
    const allow = [0, 1, 2].map((i) => addr("exec", i));
    const sesCfg = cfg({ SEND_MODE: "allowlist", SEND_AUTHORIZATION_REF: "TEST-M6-FAKE", SES_FROM_ADDRESS: "qa-sender@example.com", TEST_RECIPIENT_ALLOWLIST: allow, SES_TIMEOUT_MS: 300 });
    const t = T();
    await scheduleAt(c.id, t, deps(at(t, -5 * 60_000), undefined, sesCfg));
    await startScheduled(db, { campaignId: c.id, revision: 0, trigger: "job" }, { clock: at(t, 100) });
    let sends = 0;
    const calls: string[] = [];
    const bad = {
      send: async (cmd: SendEmailCommand | GetAccountCommand, opt?: { abortSignal?: AbortSignal }) => {
        if (cmd instanceof GetAccountCommand) return { SendingEnabled: true, SendQuota: { Max24HourSend: 1000, SentLast24Hours: 0, MaxSendRate: 10 } };
        const to = cmd.input.Destination!.ToAddresses![0];
        calls.push(to);
        sends++;
        if (sends === 1) await new Promise((_, rej) => opt?.abortSignal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        throw Object.assign(new Error("The security token included in the request is invalid."), { name: "UnrecognizedClientException", $metadata: { httpStatusCode: 403 } });
      },
    };
    const r = await drive(c.id, { cfg: sesCfg, workerId: "w", sesClient: bad, limiter: new FastLimiter(), clock: AFTER_ALL() });
    expect(r.result).toBe("blocked");
    expect(await campaign(c.id)).toMatchObject({ status: "blocked", blockCode: "credentials" });
    expect(await messageCounts(db, c.id)).toMatchObject({ unknown: 1, pending: 2, sent: 0 });
    expect((await db.select().from(adminAlerts).where(eq(adminAlerts.campaignId, c.id)))[0]).toMatchObject({ kind: "blocked" });
    const uncertain = calls[0];
    // Credentials fixed → resume: the uncertain recipient is not called again.
    const good = {
      send: async (cmd: SendEmailCommand | GetAccountCommand) => {
        if (cmd instanceof GetAccountCommand) return { SendingEnabled: true, SendQuota: { Max24HourSend: 1000, SentLast24Hours: 0, MaxSendRate: 10 } };
        calls.push(cmd.input.Destination!.ToAddresses![0]);
        return { MessageId: `ok-${calls.length}` };
      },
    };
    await resumeCampaign(db, { enqueue: async () => {} }, { campaignId: c.id, actor: ADMIN });
    expect((await drive(c.id, { cfg: sesCfg, workerId: "w", sesClient: good, limiter: new FastLimiter(), clock: AFTER_ALL() })).result).toBe("completed");
    expect(calls.filter((x) => x === uncertain)).toHaveLength(1);
    expect(await messageCounts(db, c.id)).toMatchObject({ sent: 2, unknown: 1 });
    expect((await campaign(c.id)).status).toBe("completed_with_issues");
  });
});

describe("admin alerts", () => {
  const mailCfg = (over: Partial<AlertMailConfig> = {}): AlertMailConfig => ({ ...cfg(), APP_BASE_URL: "http://localhost:3999", ...over });
  it("are emailed to active admins only through the guard (mock: sent; disabled: not sent) and can be acknowledged", async () => {
    const c = await newCampaign("alrt", 1);
    await db.insert(adminAlerts).values({ kind: "held_overdue", campaignId: c.id, message: "Campaign held (test)." });
    const mock = new MockTransport();
    await emailPendingAlerts(db, { cfg: mailCfg({ SEND_MODE: "disabled" }), mock });
    const off = (await db.select().from(adminAlerts).where(and(eq(adminAlerts.campaignId, c.id))))[0];
    expect(off.emailStatus).toBe("not_sent");
    expect(off.emailDetail).toMatch(/a\*\*\*@example.com: not sent \(sending is disabled/);
    expect(mock.calls).toHaveLength(0);
    await db.insert(adminAlerts).values({ kind: "blocked", campaignId: c.id, message: "Campaign blocked (test)." });
    await emailPendingAlerts(db, { cfg: mailCfg(), mock });
    expect(mock.calls.map((m) => [m.to, m.subject])).toEqual([["admin@example.com", "[Email MKT Tracker] Campaign blocked: Lịch alrt"]]);
    await emailPendingAlerts(db, { cfg: mailCfg(), mock }); // processed once only
    expect(mock.calls).toHaveLength(1);
    expect(await acknowledgeAlert(db, off.id, ADMIN)).toBe(true);
    expect(await acknowledgeAlert(db, off.id, ADMIN)).toBe(false);
  });
});

describe("real worker processes", () => {
  it("R-SCH-06/14: a worker restarted while scheduled still starts the campaign within the 60 s target and it completes", { timeout: 180_000 }, async () => {
    Object.assign(process.env, testEnv(url, { SEND_MODE: "mock", NOTION_MODE: "disabled" }));
    resetConfigCache();
    const c = await newCampaign("live", 4);
    const t = minute(Date.now() + 8_000);
    const real = { ...deps(at(t, -5 * 60_000)), scheduleStart: (id: string, rev: number, runAt: Date) => scheduleStartJob(id, rev, runAt, url) };
    await scheduleAt(c.id, t, real);
    const w1 = await startWorker({ databaseUrl: url, concurrency: 2, heartbeatIntervalMs: 1000, buildId: "test", workerId: "sch-w1", pollIntervalMs: 200 });
    await new Promise((r) => setTimeout(r, 500));
    await w1.stop(); // restart while scheduled
    const w2 = await startWorker({ databaseUrl: url, concurrency: 2, heartbeatIntervalMs: 1000, buildId: "test", workerId: "sch-w2", pollIntervalMs: 200 });
    workers.push(w2);
    expect((await campaign(c.id)).status).toBe("scheduled");
    const done = await waitFor(async () => {
      const s = (await campaign(c.id)).status;
      return s === "completed" || s === "completed_with_issues" ? s : null;
    }, 150_000, 250);
    expect(done).toBe("completed");
    const row = await campaign(c.id);
    expect(row.processingStartedAt!.getTime()).toBeGreaterThanOrEqual(t.getTime()); // never early
    expect(row.startDelayMs!).toBeLessThan(60_000);
    expect(await messageCounts(db, c.id)).toMatchObject({ sent: 4 });
  });
});
