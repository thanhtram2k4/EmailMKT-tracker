/**
 * M5 integration tests: the send-now engine against REAL PostgreSQL with a MOCK transport or a FAKE
 * SES client (no network, no AWS call). MOCK: these prove our logic, not the live SES service.
 * IDs refer to docs/PLAN.md "M5" (R-SEND-01…10) and "M5 regression additions" (R-M5-…).
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { GetAccountCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/lib/clock";
import { closeDb, getDb, type Db } from "../../src/lib/db/client";
import {
  auditLog,
  campaignRecipients,
  campaigns,
  campaignSnapshots,
  campaignTransitions,
  consentRecords,
  contacts,
  messageEvents,
  messages,
  notionOutbox,
  suppressions,
} from "../../src/lib/db/schema";
import { dispatchCampaign, RateLimiter, reapStaleMessageClaims, type DispatchConfig, type DispatchDeps } from "../../src/lib/campaigns/dispatcher";
import { ingestSesEvent } from "../../src/lib/campaigns/events";
import {
  approveAndSendNow,
  cancelCampaign,
  CampaignError,
  createCampaign,
  pauseCampaign,
  resolveUncertain,
  resumeCampaign,
  reviewCampaign,
  updateDraft,
  type CampaignConfig,
} from "../../src/lib/campaigns/service";
import { handleSnsPost } from "../../src/lib/campaigns/sns-handler";
import { stringToSign, type SnsMessage } from "../../src/lib/campaigns/sns";
import { updateSendSettings } from "../../src/lib/campaigns/settings";
import { lookupToken, unsubscribeByToken } from "../../src/lib/campaigns/unsubscribe";
import { MockTransport, type AccountCheck, type OutboundMessage, type SendResult } from "../../src/lib/sending/transport";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { createTestDatabase } from "./helpers";

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

const HTML = `<!DOCTYPE html><html><head><title>Bản tin</title></head><body>
<p>Chào {{ greeting_name | default: "Quý khách" }},</p>
<p><a href="https://shop.example.com/offer?utm=nov">Xem ưu đãi</a></p>
<p style="font-size:12px"><a href="{{ unsubscribe_url }}">Hủy đăng ký</a></p></body></html>`;
const SUBJECT = '[QC] Ưu đãi cho {{ greeting_name | default: "bạn" }}';

let db: Db;
let drop: () => Promise<void>;
let templateId: string;
let versionId: string;
const enqueued: string[] = [];
const enqueue = async (id: string) => {
  enqueued.push(id);
};
const ADMIN = "user:admin-test";

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  const t = await createTestDatabase("m5_send");
  drop = t.drop;
  db = getDb(t.url);
  const r = await importTemplate(db, { name: "Bản tin", html: HTML, sourceKind: "paste", actor: "test" });
  const v = await saveSubject(db, { templateId: r.template.id, baseVersionId: r.version.id, subject: SUBJECT, actor: "test" });
  templateId = r.template.id;
  versionId = v.id;
});
afterAll(async () => {
  await closeDb();
  await drop();
});

const addr = (prefix: string, i: number) => `${prefix}-${i}@example.com`;

/** Synthetic contacts with recorded (staff-entered) marketing consent, tagged with `prefix`. */
async function seed(prefix: string, n: number, o: { greetingNull?: (i: number) => boolean; consent?: boolean } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    notionPageId: `page-${prefix}-${i}`,
    fullName: `Người nhận ${i}`,
    greetingName: o.greetingNull?.(i) ? null : `Anh ${i}`,
    email: addr(prefix, i),
    emailNormalized: addr(prefix, i),
    emailStatus: "valid" as const,
    company: "Công ty Ví dụ",
    tags: [prefix],
  }));
  for (let k = 0; k < rows.length; k += 500) await db.insert(contacts).values(rows.slice(k, k + 500));
  if (o.consent !== false) {
    const cr = rows.map((r) => ({ emailNormalized: r.emailNormalized, purpose: "marketing_email" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "TEST-FORM-1" }));
    for (let k = 0; k < cr.length; k += 500) await db.insert(consentRecords).values(cr.slice(k, k + 500));
  }
}

async function newCampaign(prefix: string, n: number, o: Parameters<typeof seed>[2] = {}) {
  await seed(prefix, n, o);
  return createCampaign(db, { name: `Campaign ${prefix}`, templateId, templateVersionId: versionId, audience: { kind: "tags", tags: [prefix] }, actor: ADMIN });
}

async function approve(id: string, c: Cfg = cfg()) {
  const r = await reviewCampaign(db, c, id);
  expect(r.blocking).toEqual([]);
  await approveAndSendNow(db, { cfg: c, enqueue }, { campaignId: id, expectedRevision: r.campaign.scheduleRevision, expectedRecipients: r.resolved.included.length, actor: ADMIN });
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** No pacing in tests (the limiter itself is unit-tested); records the rate the dispatcher asked for. */
class FastLimiter extends RateLimiter {
  rates: number[] = [];
  constructor() {
    super(100_000);
  }
  override setRate(rate: number) {
    this.rates.push(rate);
  }
}
const fast = () => new FastLimiter();
const deps = (mock: MockTransport, over: Partial<DispatchDeps> = {}, c: Cfg = cfg()): DispatchDeps => ({ cfg: c, workerId: "w-test", mock, limiter: fast(), ...over });

/** Run the dispatcher like the worker would, until it stops for a reason other than "continue"/short wait. */
async function drive(id: string, d: DispatchDeps, maxRuns = 300) {
  for (let i = 0; i < maxRuns; i++) {
    const r = await dispatchCampaign(db, d, id, { budgetMs: 10_000, batchSize: 25 });
    if (r.result === "continue") continue;
    if (r.result === "waiting") {
      const wait = r.nextRunAt!.getTime() - Date.now();
      if (wait > 5000) return r;
      await sleep(Math.max(0, wait) + 5);
      continue;
    }
    return r;
  }
  throw new Error("dispatcher did not settle");
}

/** Drizzle wraps PostgreSQL errors ("Failed query: …"); the trigger's message is in `cause`. */
async function dbError(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return String(err.cause?.message ?? err.message);
  }
  return "(no error)";
}
const campaign = async (id: string) => (await db.select().from(campaigns).where(eq(campaigns.id, id)))[0];
const msgs = (id: string) => db.select().from(messages).where(eq(messages.campaignId, id));
const byStatus = async (id: string) => {
  const out: Record<string, number> = {};
  for (const m of await msgs(id)) out[m.sendStatus] = (out[m.sendStatus] ?? 0) + 1;
  return out;
};
function recorder(fn: (m: OutboundMessage, n: number) => SendResult | Promise<SendResult> = (m) => ({ kind: "accepted", providerMessageId: `ses-${m.messageId}-${m.tags?.attempt}` }), opts: ConstructorParameters<typeof MockTransport>[1] = {}) {
  let n = 0;
  return new MockTransport((m) => fn(m, n++), opts);
}
const dupIds = (calls: OutboundMessage[]) => {
  const seen = new Map<string, number>();
  for (const c of calls) seen.set(c.messageId, (seen.get(c.messageId) ?? 0) + 1);
  return [...seen.entries()].filter(([, k]) => k > 1);
};

describe("review and approval (snapshot freeze)", () => {
  it("R-M5-01: review blocks on missing unsubscribe link, missing subject, missing values, empty audience and a disabled guard", async () => {
    const noUnsub = await importTemplate(db, { name: "x", html: "<p>Chào {{ greeting_name }}</p>", sourceKind: "paste", actor: "test" });
    await seed("rv", 3, { greetingNull: (i) => i === 0 });
    const c = await createCampaign(db, { name: "rv", templateId: noUnsub.template.id, audience: { kind: "tags", tags: ["rv"] }, actor: ADMIN });
    const r = await reviewCampaign(db, cfg(), c.id);
    const all = r.blocking.join("\n");
    expect(all).toMatch(/no subject/);
    expect(all).toMatch(/no unsubscribe link/);
    expect(all).toMatch(/1 recipient\(s\) have no value/);
    expect(r.missingValues.map((m) => m.missing)).toEqual([["greeting_name"]]);

    const empty = await createCampaign(db, { name: "empty", templateId, templateVersionId: versionId, audience: { kind: "tags", tags: ["no-such-tag"] }, actor: ADMIN });
    expect((await reviewCampaign(db, cfg(), empty.id)).blocking.join()).toMatch(/No eligible recipients/);
    expect((await reviewCampaign(db, cfg({ SEND_MODE: "disabled" }), empty.id)).blocking.join()).toMatch(/sending is disabled/);
    await expect(approveAndSendNow(db, { cfg: cfg(), enqueue }, { campaignId: c.id, expectedRevision: 0, expectedRecipients: 3, actor: ADMIN })).rejects.toThrow(CampaignError);
    expect((await campaign(c.id)).status).toBe("draft");
  });

  it("R-M5-02: consent, suppression and duplicates are excluded with counts; a staging allowlist refuses non-allowlisted recipients", async () => {
    await seed("ex", 4);
    await seed("exnc", 2, { consent: false });
    await db.update(contacts).set({ tags: ["ex"] }).where(sql`notion_page_id like 'page-exnc-%'`);
    await db.insert(suppressions).values({ emailNormalized: addr("ex", 0), reason: "manual", source: "test", createdBy: "test" });
    const c = await createCampaign(db, { name: "ex", templateId, templateVersionId: versionId, audience: { kind: "tags", tags: ["ex"] }, actor: ADMIN });
    const r = await reviewCampaign(db, cfg(), c.id);
    expect(r.resolved.matched).toBe(6);
    expect(r.resolved.included.length).toBe(3);
    expect(r.resolved.excludedByReason).toMatchObject({ suppressed: 1, consent_unknown: 2 });
    const staging = await reviewCampaign(db, cfg({ APP_ENV: "staging", SEND_MODE: "allowlist", SEND_AUTHORIZATION_REF: "X", SES_FROM_ADDRESS: "qa@example.com", TEST_RECIPIENT_ALLOWLIST: [addr("ex", 1)] }), c.id);
    expect(staging.blocking.join()).toMatch(/not on TEST_RECIPIENT_ALLOWLIST/);
  });

  it("R-M5-03: an edit after review increments the revision and the stale approval is refused; a changed audience is refused", async () => {
    const c = await newCampaign("rev", 3);
    const r = await reviewCampaign(db, cfg(), c.id);
    await updateDraft(db, { campaignId: c.id, name: "renamed", actor: ADMIN });
    await expect(approveAndSendNow(db, { cfg: cfg(), enqueue }, { campaignId: c.id, expectedRevision: r.campaign.scheduleRevision, expectedRecipients: 3, actor: ADMIN })).rejects.toThrow(/edited after you reviewed/);
    await seed("rev2", 1);
    await db.update(contacts).set({ tags: ["rev"] }).where(eq(contacts.notionPageId, "page-rev2-0"));
    await expect(approveAndSendNow(db, { cfg: cfg(), enqueue }, { campaignId: c.id, expectedRevision: r.campaign.scheduleRevision + 1, expectedRecipients: 3, actor: ADMIN })).rejects.toThrow(
      /audience changed since your review \(now 4/,
    );
    expect(await db.select().from(campaignSnapshots).where(eq(campaignSnapshots.campaignId, c.id))).toHaveLength(0);
  });

  it("R-M5-04: approval freezes content and merge values; later CRM edits do not change what is sent; the snapshot is immutable", async () => {
    const c = await newCampaign("frz", 2, { greetingNull: (i) => i === 1 });
    await approve(c.id);
    expect(enqueued).toContain(c.id);
    // Edit the CRM after approval: the frozen value must be used.
    await db.update(contacts).set({ greetingName: "Chị Đổi Tên" }).where(eq(contacts.notionPageId, "page-frz-0"));
    const mock = recorder();
    const r = await drive(c.id, deps(mock));
    expect(r.result).toBe("completed");
    const first = mock.calls.find((m) => m.to === addr("frz", 0))!;
    expect(first.subject).toBe("[QC] Ưu đãi cho Anh 0");
    expect(first.html).toContain("Chào Anh 0,");
    const second = mock.calls.find((m) => m.to === addr("frz", 1))!;
    expect(second.html).toContain("Chào Quý khách,");
    // Unsubscribe: footer link, plain-text line and RFC 8058 headers, all with the opaque token.
    const token = (await msgs(c.id)).find((m) => m.emailNormalized === addr("frz", 0))!.trackingToken;
    expect(first.html).toContain(`http://localhost:3999/u/${token}`);
    expect(first.text).toContain(`http://localhost:3999/u/${token}`);
    expect(first.headers).toMatchObject({ "List-Unsubscribe": `<http://localhost:3999/u/${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(first.html).not.toContain(addr("frz", 0).split("@")[0] + "%40");
    expect(first.tags).toMatchObject({ purpose: "campaign", campaign: c.id, attempt: "1" });

    const snap = (await db.select().from(campaignSnapshots).where(eq(campaignSnapshots.campaignId, c.id)))[0];
    expect(await dbError(db.update(campaignSnapshots).set({ html: "<p>changed</p>" }).where(eq(campaignSnapshots.id, snap.id)))).toMatch(/append-only/);
    expect(await dbError(db.update(campaignRecipients).set({ mergeValues: {} }).where(eq(campaignRecipients.snapshotId, snap.id)))).toMatch(/append-only/);
    expect(await dbError(db.update(campaigns).set({ snapshotId: null }).where(eq(campaigns.id, c.id)))).toMatch(/cannot be changed/);
    const links = await db.execute(sql`select idx, url from campaign_links where snapshot_id = ${snap.id} order by idx`);
    expect(links.rows).toEqual([{ idx: 0, url: "https://shop.example.com/offer?utm=nov" }]);
  });
});

describe("dispatcher (MOCK transport)", () => {
  it("R-SEND-01: 500 recipients are each sent exactly once and the campaign completes", async () => {
    const c = await newCampaign("big", 500, { greetingNull: (i) => i % 7 === 0 });
    await approve(c.id);
    const mock = recorder();
    const r = await drive(c.id, deps(mock));
    expect(r.result).toBe("completed");
    expect(mock.calls).toHaveLength(500);
    expect(dupIds(mock.calls)).toEqual([]);
    expect(new Set(mock.calls.map((m) => m.to)).size).toBe(500);
    expect(await byStatus(c.id)).toEqual({ sent: 500 });
    expect((await campaign(c.id)).status).toBe("completed");
    const tr = await db.select().from(campaignTransitions).where(eq(campaignTransitions.campaignId, c.id)).orderBy(campaignTransitions.id);
    expect(tr.map((t) => `${t.fromStatus}->${t.toStatus}`)).toEqual(["draft->queued", "queued->sending", "sending->completed"]);
    // a further run does nothing
    await drive(c.id, deps(mock));
    expect(mock.calls).toHaveLength(500);
  });

  it("R-SEND-02: four concurrent dispatchers (two workers each) never send a message twice", async () => {
    const c = await newCampaign("conc", 200);
    await approve(c.id);
    const mock = recorder(async (m) => {
      await sleep(1);
      return { kind: "accepted", providerMessageId: `ses-${m.messageId}` };
    });
    const results: string[] = [];
    const loop = async (w: string) => {
      for (let i = 0; i < 400; i++) {
        const r = await dispatchCampaign(db, deps(mock, { workerId: w }), c.id, { budgetMs: 300, batchSize: 10 });
        results.push(r.result);
        if (r.result === "completed" || (await campaign(c.id)).status === "completed") return;
        if (r.result === "locked") await sleep(5);
      }
    };
    await Promise.all(["w1", "w2", "w3", "w4"].map(loop));
    expect(results).toContain("locked"); // the advisory lock really was contended
    expect(mock.calls).toHaveLength(200);
    expect(dupIds(mock.calls)).toEqual([]);
    expect(await byStatus(c.id)).toEqual({ sent: 200 });
  });

  it("R-SEND-03 (in-process part): claims left by a crashed worker become unknown and are never re-sent", async () => {
    const c = await newCampaign("crash", 10);
    await approve(c.id);
    // Simulate a worker that committed claims and died before calling the provider for 3 messages.
    const victims = (await msgs(c.id)).slice(0, 3).map((m) => m.id);
    const old = new Date(Date.now() - 11 * 60_000);
    await db.execute(sql`update messages set send_status = 'claimed', claimed_by = 'dead-worker', claimed_at = ${old.toISOString()}::timestamptz
                         where id in (${sql.join(victims.map((v) => sql`${v}::uuid`), sql`, `)})`);
    const mock = recorder();
    const first = await drive(c.id, deps(mock));
    expect(first.result).toBe("waiting"); // 7 sent; 3 still claimed elsewhere
    expect(mock.calls).toHaveLength(7);
    expect(await reapStaleMessageClaims(db)).toBe(3);
    const r = await drive(c.id, deps(mock));
    expect(r.result).toBe("completed");
    expect(mock.calls.map((m) => m.messageId).filter((id) => victims.includes(id))).toEqual([]);
    expect(await byStatus(c.id)).toEqual({ sent: 7, unknown: 3 });
    expect((await campaign(c.id)).status).toBe("completed_with_issues");
    // a stale claim can never become pending again (DB guard)
    expect(await dbError(db.update(messages).set({ sendStatus: "pending" }).where(eq(messages.id, victims[0])))).toMatch(/illegal messages send_status/);
  });

  it("R-SEND-08: an address unsubscribed (or consent withdrawn) while queued is skipped", async () => {
    const c = await newCampaign("unsq", 4);
    await approve(c.id);
    const ms = await msgs(c.id);
    const t0 = ms.find((m) => m.emailNormalized === addr("unsq", 0))!;
    expect(await unsubscribeByToken(db, t0.trackingToken, { method: "one_click" })).toMatchObject({ added: true });
    await db.insert(consentRecords).values({ emailNormalized: addr("unsq", 1), purpose: "marketing_email", status: "withdrawn", source: "staff_entry", recordedBy: "test", evidenceNote: "phone call" });
    const mock = recorder();
    await drive(c.id, deps(mock));
    expect(mock.calls.map((m) => m.to).sort()).toEqual([addr("unsq", 2), addr("unsq", 3)]);
    const after = await msgs(c.id);
    expect(after.find((m) => m.emailNormalized === addr("unsq", 0))).toMatchObject({ sendStatus: "skipped", skipReason: "suppressed" });
    expect(after.find((m) => m.emailNormalized === addr("unsq", 1))).toMatchObject({ sendStatus: "skipped", skipReason: "consent_withdrawn" });
    expect((await campaign(c.id)).status).toBe("completed");
  });

  it("R-SEND-05: throttling backs off and recovers without unknown outcomes or duplicates", async () => {
    const c = await newCampaign("thr", 6);
    await approve(c.id);
    let throttled = 0;
    const mock = recorder((m) => {
      if (m.to === addr("thr", 2) && throttled < 3) {
        throttled++;
        return { kind: "retryable", code: "TooManyRequestsException", message: "Maximum sending rate exceeded.", retryAfterMs: 20 };
      }
      return { kind: "accepted", providerMessageId: `ses-${m.messageId}` };
    });
    const r = await drive(c.id, deps(mock));
    expect(r.result).toBe("completed");
    expect(mock.calls.filter((m) => m.to === addr("thr", 2))).toHaveLength(4);
    expect(mock.sent).toHaveLength(6);
    expect(await byStatus(c.id)).toEqual({ sent: 6 });
    expect((await msgs(c.id)).find((m) => m.emailNormalized === addr("thr", 2))!.throttleCount).toBe(3);
  });

  it("R-SEND-06: an exhausted quota (with the reserve) blocks the campaign; resume after the quota renews completes it", async () => {
    await updateSendSettings(db, { quotaReservePct: 10, actor: ADMIN, appEnv: "test" });
    const c = await newCampaign("quota", 12);
    await approve(c.id);
    let sentLast24h = 85; // budget = floor(100 * 0.9) - 85 = 5
    const acct = (): AccountCheck => ({ ok: true, sendingEnabled: true, max24h: 100, sentLast24h, maxPerSecond: 14 });
    const mock = recorder(
      (m) => {
        sentLast24h++;
        return { kind: "accepted", providerMessageId: `ses-${m.messageId}` };
      },
      { account: acct },
    );
    const lim = fast();
    const r = await drive(c.id, deps(mock, { limiter: lim }));
    expect(r.result).toBe("blocked");
    expect(mock.calls).toHaveLength(5);
    expect(lim.rates).toEqual([5]); // min(setting 5/s, 80% of the account's 14/s)
    const b = await campaign(c.id);
    expect(b).toMatchObject({ status: "blocked", blockCode: "quota" });
    expect(b.blockMessage).toMatch(/10% reserve/);
    expect(await byStatus(c.id)).toEqual({ sent: 5, pending: 7 });
    // Resume while still exhausted: blocked again, nothing sent.
    await resumeCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN });
    expect((await drive(c.id, deps(mock))).result).toBe("blocked");
    expect(mock.calls).toHaveLength(5);
    // Quota renewed (rolling window): resume completes without duplicates.
    sentLast24h = 0;
    await resumeCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN });
    expect((await drive(c.id, deps(mock))).result).toBe("completed");
    expect(mock.calls).toHaveLength(12);
    expect(dupIds(mock.calls)).toEqual([]);
  });

  it("R-SEND-10: pause stops sending, resume continues, cancel reports a partial result; nothing is sent twice", async () => {
    const c = await newCampaign("pz", 30);
    await approve(c.id);
    let paused = false;
    const mock = recorder(async (m, n) => {
      if (n === 9 && !paused) {
        paused = true;
        await pauseCampaign(db, { campaignId: c.id, actor: ADMIN });
      }
      return { kind: "accepted", providerMessageId: `ses-${m.messageId}` };
    });
    const r1 = await drive(c.id, deps(mock));
    expect(r1.result).toBe("paused");
    expect(mock.calls).toHaveLength(10); // the in-flight call completes; nothing after it
    expect(await byStatus(c.id)).toEqual({ sent: 10, pending: 20 }); // claimed rows released, not lost
    await expect(pauseCampaign(db, { campaignId: c.id, actor: ADMIN })).rejects.toThrow(/Only a queued or sending/);

    await resumeCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN });
    let cancelled = false;
    const mock2 = recorder(async (m, n) => {
      if (n === 4 && !cancelled) {
        cancelled = true;
        await cancelCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN });
      }
      return { kind: "accepted", providerMessageId: `ses-${m.messageId}` };
    });
    const r2 = await drive(c.id, deps(mock2));
    expect(r2.result).toBe("cancelled");
    expect(mock2.calls).toHaveLength(5);
    expect(dupIds([...mock.calls, ...mock2.calls])).toEqual([]);
    expect(await byStatus(c.id)).toEqual({ sent: 15, cancelled: 15 });
    const c2 = await campaign(c.id);
    expect(c2.status).toBe("cancelled");
    const last = (await db.select().from(campaignTransitions).where(eq(campaignTransitions.campaignId, c.id)).orderBy(campaignTransitions.id)).at(-1)!;
    expect(last.reason).toBe("cancelled: 15 sent, 0 uncertain, 15 not sent");
    await expect(resumeCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN })).rejects.toThrow(/Only a paused or blocked/);
  });

  it("R-M5-05: cancelling a paused campaign with no claims in flight finishes immediately", async () => {
    const c = await newCampaign("cxp", 3);
    await approve(c.id);
    await pauseCampaign(db, { campaignId: c.id, actor: ADMIN });
    expect(await cancelCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN })).toEqual({ finished: true });
    expect(await byStatus(c.id)).toEqual({ cancelled: 3 });
    expect((await campaign(c.id)).status).toBe("cancelled");
  });
});

describe("uncertain outcomes and SES (fake client, no network)", () => {
  const sesCfg = (allow: string[]) => cfg({ SEND_MODE: "allowlist", SEND_AUTHORIZATION_REF: "TEST-M5-FAKE", SES_FROM_ADDRESS: "qa-sender@example.com", TEST_RECIPIENT_ALLOWLIST: allow, SES_TIMEOUT_MS: 300 });

  function fakeSes(o: { hang?: string; sendError?: unknown; accountError?: unknown }) {
    const sent: string[] = [];
    return {
      sent,
      client: {
        send: async (cmd: SendEmailCommand | GetAccountCommand, opt?: { abortSignal?: AbortSignal }) => {
          if (cmd instanceof GetAccountCommand) {
            if (o.accountError) throw o.accountError;
            return { SendingEnabled: true, ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200, SentLast24Hours: 0, MaxSendRate: 1 } };
          }
          const to = cmd.input.Destination!.ToAddresses![0];
          if (o.sendError) throw o.sendError;
          if (to === o.hang) {
            await new Promise((_, rej) => opt?.abortSignal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
          }
          sent.push(to);
          return { MessageId: `0100-fake-${sent.length}` };
        },
      },
    };
  }

  it("R-SEND-04: a provider timeout gives `unknown`, is never retried automatically, and a later SES event reconciles it", async () => {
    const c = await newCampaign("tmo", 3);
    const allow = [0, 1, 2].map((i) => addr("tmo", i));
    await approve(c.id, sesCfg(allow));
    const ses = fakeSes({ hang: addr("tmo", 1) });
    const d: DispatchDeps = { cfg: sesCfg(allow), workerId: "w-ses", sesClient: ses.client, limiter: fast() };
    expect((await drive(c.id, d)).result).toBe("completed");
    expect(await byStatus(c.id)).toEqual({ sent: 2, unknown: 1 });
    expect((await campaign(c.id)).status).toBe("completed_with_issues");
    await drive(c.id, d); // runs again: nothing re-sent
    expect([...ses.sent].sort()).toEqual([addr("tmo", 0), addr("tmo", 2)]);

    const u = (await msgs(c.id)).find((m) => m.sendStatus === "unknown")!;
    const ev = { eventType: "Delivery", mail: { messageId: "0100-late", timestamp: new Date().toISOString(), tags: { msg_id: [u.id], purpose: ["campaign"], attempt: ["1"] } }, delivery: { timestamp: new Date().toISOString() } };
    expect(await ingestSesEvent(db, "sns-tmo-1", ev)).toMatchObject({ status: "processed", matched: "campaign", reconciled: true });
    expect(await ingestSesEvent(db, "sns-tmo-1", ev)).toMatchObject({ status: "duplicate" });
    const fixed = (await db.select().from(messages).where(eq(messages.id, u.id)))[0];
    expect(fixed).toMatchObject({ sendStatus: "sent", deliveryStatus: "delivered", providerMessageId: "0100-late" });
    expect((await db.select().from(auditLog).where(and(eq(auditLog.action, "message.reconciled_sent"), eq(auditLog.entityId, u.id)))).length).toBe(1);
  });

  it("R-M5-06: staff may resend or mark uncertain messages only after 60 minutes; a resend is a new attempt", async () => {
    const c = await newCampaign("res", 3);
    await approve(c.id);
    const mock = recorder((m) => (m.to === addr("res", 0) && m.tags?.attempt === "1" ? { kind: "unknown", message: "socket hang up" } : { kind: "accepted", providerMessageId: `ses-${m.messageId}-${m.tags?.attempt}` }));
    await drive(c.id, deps(mock));
    expect(await byStatus(c.id)).toEqual({ sent: 2, unknown: 1 });
    await expect(resolveUncertain(db, { enqueue }, { campaignId: c.id, action: "resend", actor: ADMIN })).rejects.toThrow(/60 minutes/);
    const later = new FixedClock(new Date(Date.now() + 61 * 60_000));
    expect(await resolveUncertain(db, { enqueue, clock: later }, { campaignId: c.id, action: "resend", actor: ADMIN })).toEqual({ count: 1 });
    expect((await campaign(c.id)).status).toBe("sending");
    await drive(c.id, deps(mock, { clock: later }));
    const calls = mock.calls.filter((m) => m.to === addr("res", 0)).map((m) => m.tags?.attempt);
    expect(calls).toEqual(["1", "2"]);
    const m0 = (await msgs(c.id)).find((m) => m.emailNormalized === addr("res", 0))!;
    expect(m0).toMatchObject({ sendStatus: "sent", attemptNo: 2, resolution: "resend_approved", resolvedBy: ADMIN });
    expect((await db.select().from(auditLog).where(and(eq(auditLog.action, "campaign.uncertain_resend_approved"), eq(auditLog.entityId, c.id)))).length).toBe(1);
  });

  it("R-M5-07: mark-not-sent is audited, and later provider evidence still reconciles it to sent", async () => {
    const c = await newCampaign("mns", 2);
    await approve(c.id);
    await drive(c.id, deps(recorder((m) => (m.to === addr("mns", 0) ? { kind: "unknown", message: "timeout" } : { kind: "accepted", providerMessageId: "x" }))));
    const later = new FixedClock(new Date(Date.now() + 61 * 60_000));
    await resolveUncertain(db, { enqueue, clock: later }, { campaignId: c.id, action: "mark_not_sent", actor: ADMIN });
    const m0 = (await msgs(c.id)).find((m) => m.emailNormalized === addr("mns", 0))!;
    expect(m0.sendStatus).toBe("marked_not_sent");
    await ingestSesEvent(db, "sns-mns-1", { eventType: "Send", mail: { messageId: "0100-mns", timestamp: new Date().toISOString(), tags: { msg_id: [m0.id] } } });
    expect((await db.select().from(messages).where(eq(messages.id, m0.id)))[0].sendStatus).toBe("sent");
  });

  it("R-SEND-07: invalid credentials block the campaign; nothing is marked failed or sent", async () => {
    const c = await newCampaign("cred", 3);
    const allow = [0, 1, 2].map((i) => addr("cred", i));
    await approve(c.id, sesCfg(allow));
    const ses = fakeSes({ accountError: Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }) });
    const r = await drive(c.id, { cfg: sesCfg(allow), workerId: "w", sesClient: ses.client, limiter: fast() });
    expect(r.result).toBe("blocked");
    expect(await campaign(c.id)).toMatchObject({ status: "blocked", blockCode: "credentials" });
    expect(await byStatus(c.id)).toEqual({ pending: 3 });
    expect(ses.sent).toEqual([]);

    // Account check passes but the send itself is refused for credentials (e.g. a revoked key).
    await resumeCampaign(db, { enqueue }, { campaignId: c.id, actor: ADMIN });
    const ses2 = fakeSes({ sendError: Object.assign(new Error("The security token included in the request is invalid."), { name: "UnrecognizedClientException", $metadata: { httpStatusCode: 403 } }) });
    expect((await drive(c.id, { cfg: sesCfg(allow), workerId: "w", sesClient: ses2.client, limiter: fast() })).result).toBe("blocked");
    expect(await campaign(c.id)).toMatchObject({ status: "blocked", blockCode: "credentials" });
    expect(await byStatus(c.id)).toEqual({ pending: 3 });
  });

  it("R-SEND-09: hard bounces and complaints suppress automatically; soft bounces do not; a completed campaign shows issues", async () => {
    const c = await newCampaign("bnc", 3);
    await approve(c.id);
    await drive(c.id, deps(recorder()));
    expect((await campaign(c.id)).status).toBe("completed");
    const [m0, m1, m2] = ["bnc-0", "bnc-1", "bnc-2"].map(async (p) => (await msgs(c.id)).find((m) => m.emailNormalized === `${p}@example.com`)!);
    const tags = async (m: Promise<typeof messages.$inferSelect>) => ({ msg_id: [(await m).id], purpose: ["campaign"], attempt: ["1"] });
    const now = new Date().toISOString();
    await ingestSesEvent(db, "sns-bnc-hard", { eventType: "Bounce", mail: { messageId: "p0", timestamp: now, tags: await tags(m0) }, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: addr("bnc", 0), diagnosticCode: "smtp; 550 5.1.1 bnc-0@example.com user unknown" }] } });
    await ingestSesEvent(db, "sns-bnc-soft", { eventType: "Bounce", mail: { messageId: "p1", timestamp: now, tags: await tags(m1) }, bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: addr("bnc", 1) }] } });
    await ingestSesEvent(db, "sns-bnc-cmp", { eventType: "Complaint", mail: { messageId: "p2", timestamp: now, tags: await tags(m2) }, complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: addr("bnc", 2) }] } });

    const sup = await db.select().from(suppressions).where(sql`email_normalized like 'bnc-%'`);
    expect(sup.map((s) => [s.emailNormalized, s.reason]).sort()).toEqual([
      [addr("bnc", 0), "hard_bounce"],
      [addr("bnc", 2), "complaint"],
    ]);
    const after = await msgs(c.id);
    expect(after.map((m) => [m.emailNormalized, m.deliveryStatus]).sort()).toEqual([
      [addr("bnc", 0), "bounced_hard"],
      [addr("bnc", 1), "bounced_soft"],
      [addr("bnc", 2), "complained"],
    ]);
    expect((await campaign(c.id)).status).toBe("completed_with_issues");
    // complaint withdraws consent; both suppressions queue the Notion write-back
    const consent = await db.select().from(consentRecords).where(eq(consentRecords.emailNormalized, addr("bnc", 2))).orderBy(consentRecords.id);
    expect(consent.at(-1)).toMatchObject({ status: "withdrawn", source: "system" });
    const outbox = await db.select().from(notionOutbox).where(sql`notion_page_id in ('page-bnc-0', 'page-bnc-2')`);
    expect(outbox.map((o) => [o.notionPageId, (o.payload as { label: string }).label]).sort()).toEqual([
      ["page-bnc-0", "Bounced"],
      ["page-bnc-2", "Complained"],
    ]);
    // stored diagnostic is redacted
    const ev = (await db.select().from(messageEvents).where(eq(messageEvents.providerEventId, "sns-bnc-hard")))[0];
    expect(JSON.stringify(ev.detail)).not.toContain("bnc-0@example.com");
    // a later Delivery does not downgrade a complaint
    await ingestSesEvent(db, "sns-bnc-late", { eventType: "Delivery", mail: { messageId: "p2", tags: await tags(m2) }, delivery: {} });
    expect((await msgs(c.id)).find((m) => m.emailNormalized === addr("bnc", 2))!.deliveryStatus).toBe("complained");
  });
});

describe("unsubscribe (GET confirms only, POST unsubscribes)", () => {
  it("R-M5-08: lookup does not unsubscribe; POST suppresses, withdraws consent, queues Notion, records an event; repeat is harmless", async () => {
    const c = await newCampaign("uns", 1);
    await approve(c.id);
    const token = (await msgs(c.id))[0].trackingToken;
    expect(await lookupToken(db, token)).toMatchObject({ maskedEmail: "u***@example.com", alreadySuppressed: false });
    expect(await db.select().from(suppressions).where(eq(suppressions.emailNormalized, addr("uns", 0)))).toHaveLength(0);
    expect(await lookupToken(db, "short")).toBeNull();
    expect(await lookupToken(db, "A".repeat(22))).toBeNull();

    expect(await unsubscribeByToken(db, token, { method: "one_click" })).toEqual({ maskedEmail: "u***@example.com", added: true });
    expect(await unsubscribeByToken(db, token, { method: "confirm_page" })).toEqual({ maskedEmail: "u***@example.com", added: false });
    const s = (await db.select().from(suppressions).where(eq(suppressions.emailNormalized, addr("uns", 0))))[0];
    expect(s).toMatchObject({ reason: "unsubscribe", source: "unsubscribe_one_click", campaignId: c.id });
    const cr = await db.select().from(consentRecords).where(eq(consentRecords.emailNormalized, addr("uns", 0))).orderBy(consentRecords.id);
    expect(cr.filter((r) => r.status === "withdrawn")).toHaveLength(1);
    expect(cr.at(-1)).toMatchObject({ status: "withdrawn", source: "unsubscribe_link" });
    expect(await db.select().from(notionOutbox).where(eq(notionOutbox.notionPageId, "page-uns-0"))).toHaveLength(1);
    expect(await db.select().from(messageEvents).where(and(eq(messageEvents.campaignId, c.id), eq(messageEvents.type, "unsubscribe")))).toHaveLength(2);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "suppression.unsubscribed"));
    expect(JSON.stringify(audits)).not.toContain(addr("uns", 0));
  });
});

describe("SNS endpoint verification (generated RSA key; no AWS call)", () => {
  const TOPIC = "arn:aws:sns:ap-southeast-1:123456789012:ses-events";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const resolveCert = async () => pub;
  const hcfg = { APP_ENV: "test" as const, SES_EVENTS_TOPIC_ARN: TOPIC, SNS_TEST_PUBLIC_KEY_FILE: undefined };

  function signed(over: Partial<SnsMessage> & { Message: string }, version: "1" | "2" = "2", key = privateKey): string {
    const m: SnsMessage = {
      Type: "Notification",
      MessageId: `sns-${Math.random().toString(36).slice(2)}`,
      TopicArn: TOPIC,
      Timestamp: new Date().toISOString(),
      SignatureVersion: version,
      Signature: "",
      SigningCertURL: "https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-abc.pem",
      ...over,
    };
    m.Signature = sign(version === "1" ? "sha1" : "sha256", Buffer.from(stringToSign(m), "utf8"), key).toString("base64");
    return JSON.stringify(m);
  }

  it("R-M5-09: accepts correctly signed notifications (v1 and v2) and rejects bad signatures, other topics, other cert hosts and stale messages", async () => {
    const c = await newCampaign("sns", 1);
    await approve(c.id);
    await drive(c.id, deps(recorder()));
    const m = (await msgs(c.id))[0];
    const evt = JSON.stringify({ eventType: "Delivery", mail: { messageId: "0100-sns", timestamp: new Date().toISOString(), tags: { msg_id: [m.id], purpose: ["campaign"] } }, delivery: {} });

    expect(await handleSnsPost(db, hcfg, signed({ Message: evt }), { resolveCert, messageTypeHeader: "Notification" })).toEqual({ status: 200, body: "processed" });
    expect((await db.select().from(messages).where(eq(messages.id, m.id)))[0].deliveryStatus).toBe("delivered");
    expect((await handleSnsPost(db, hcfg, signed({ Message: evt, Subject: "Amazon SES Email Event Notification" }, "1"), { resolveCert })).status).toBe(200);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(await handleSnsPost(db, hcfg, signed({ Message: evt }, "2", other), { resolveCert })).toEqual({ status: 403, body: "verification failed" });
    const tampered = JSON.parse(signed({ Message: evt }));
    tampered.Message = evt.replace("Delivery", "Complaint");
    expect((await handleSnsPost(db, hcfg, JSON.stringify(tampered), { resolveCert })).status).toBe(403);
    expect((await handleSnsPost(db, hcfg, signed({ Message: evt, TopicArn: "arn:aws:sns:ap-southeast-1:999999999999:other" }), { resolveCert })).status).toBe(403);
    let fetched = false;
    const spy = async () => {
      fetched = true;
      return pub;
    };
    for (const url of ["http://sns.ap-southeast-1.amazonaws.com/x.pem", "https://sns.ap-southeast-1.amazonaws.com.evil.example/x.pem", "https://evil.example/x.pem", "https://sns.ap-southeast-1.amazonaws.com/x.txt"]) {
      expect((await handleSnsPost(db, hcfg, signed({ Message: evt, SigningCertURL: url }), { resolveCert: spy })).status).toBe(403);
    }
    expect(fetched).toBe(false); // a bad certificate URL is never fetched
    expect((await handleSnsPost(db, hcfg, signed({ Message: evt, Timestamp: new Date(Date.now() - 25 * 3600_000).toISOString() }), { resolveCert })).status).toBe(403);
    expect((await handleSnsPost(db, hcfg, "not json", { resolveCert })).status).toBe(400);
    expect((await handleSnsPost(db, { ...hcfg, SES_EVENTS_TOPIC_ARN: undefined }, signed({ Message: evt }), { resolveCert })).status).toBe(503);
    expect((await handleSnsPost(db, hcfg, signed({ Message: evt }), { resolveCert, messageTypeHeader: "SubscriptionConfirmation" })).status).toBe(400);
    const rejected = await db.select().from(auditLog).where(eq(auditLog.action, "ses_events.rejected"));
    expect(rejected.length).toBeGreaterThanOrEqual(8);
  });

  it("R-M5-10: a subscription confirmation is verified and recorded, never confirmed automatically", async () => {
    const body = signed({ Type: "SubscriptionConfirmation", Message: "You have chosen to subscribe…", SubscribeURL: "https://sns.ap-southeast-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc", Token: "abc" });
    expect(await handleSnsPost(db, hcfg, body, { resolveCert })).toEqual({ status: 200, body: "recorded" });
    const a = (await db.select().from(auditLog).where(eq(auditLog.action, "ses_events.SubscriptionConfirmation")))[0];
    expect(a.after).toEqual({ subscribeHost: "sns.ap-southeast-1.amazonaws.com" });
  });
});

describe("database guards (defence in depth)", () => {
  it("R-M5-11: message status is forward-only, rows cannot be deleted, transitions are append-only", async () => {
    const c = await newCampaign("grd", 2);
    await approve(c.id);
    await drive(c.id, deps(recorder()));
    const [a] = await msgs(c.id);
    expect(await dbError(db.update(messages).set({ sendStatus: "pending" }).where(eq(messages.id, a.id)))).toMatch(/illegal messages send_status change sent -> pending/);
    expect(await dbError(db.update(messages).set({ sendStatus: "claimed" }).where(eq(messages.id, a.id)))).toMatch(/illegal/);
    expect(await dbError(db.update(messages).set({ attemptNo: 5 }).where(eq(messages.id, a.id)))).toMatch(/attempt_no/);
    expect(await dbError(db.update(messages).set({ trackingToken: "x".repeat(22) }).where(eq(messages.id, a.id)))).toMatch(/immutable/);
    expect(await dbError(db.delete(messages).where(eq(messages.id, a.id)))).toMatch(/cannot be deleted/);
    expect(await dbError(db.delete(campaigns).where(eq(campaigns.id, c.id)))).toMatch(/cannot be deleted/);
    expect(await dbError(db.delete(campaignTransitions).where(eq(campaignTransitions.campaignId, c.id)))).toMatch(/append-only/);
    // delivery status may still change (events)
    await db.update(messages).set({ deliveryStatus: "delivered" }).where(eq(messages.id, a.id));
  });

  it("R-M5-12: live customer campaigns cannot be enabled outside production", async () => {
    await expect(updateSendSettings(db, { liveCampaignsEnabled: true, actor: ADMIN, appEnv: "staging" })).rejects.toThrow(/only be enabled in production/);
    await expect(updateSendSettings(db, { ratePerSecond: 500, actor: ADMIN, appEnv: "test" })).rejects.toThrow(/between/);
  });
});
