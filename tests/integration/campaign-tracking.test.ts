/**
 * M7 integration tests: open/click tracking and analytics against REAL PostgreSQL with the MOCK
 * transport (no network). IDs refer to docs/PLAN.md "M7".
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/lib/clock";
import { closeDb, getDb, type Db } from "../../src/lib/db/client";
import { campaignLinks, consentRecords, contacts, messageEvents, messages, testSends } from "../../src/lib/db/schema";
import { campaignAnalytics, linkAnalytics, rate, recipientTimeline } from "../../src/lib/campaigns/analytics";
import { dispatchCampaign, RateLimiter, type DispatchConfig } from "../../src/lib/campaigns/dispatcher";
import { ingestSesEvent } from "../../src/lib/campaigns/events";
import { approveAndSendNow, createCampaign, reviewCampaign, type CampaignConfig } from "../../src/lib/campaigns/service";
import { updateSendSettings, type TrackingMode } from "../../src/lib/campaigns/settings";
import { recordClick, recordOpen, type RequestInfo } from "../../src/lib/campaigns/tracking";
import { unsubscribeByToken } from "../../src/lib/campaigns/unsubscribe";
import { sendTestEmail } from "../../src/lib/sending/test-send";
import { MockTransport } from "../../src/lib/sending/transport";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { createTestDatabase } from "./helpers";

type Cfg = DispatchConfig & CampaignConfig;
const cfg: Cfg = {
  APP_ENV: "test",
  SEND_MODE: "mock",
  TEST_RECIPIENT_ALLOWLIST: ["qa-inbox@example.com"],
  SEND_AUTHORIZATION_REF: undefined,
  SES_REGION: "ap-southeast-1",
  SES_FROM_ADDRESS: undefined,
  SES_CONFIGURATION_SET: undefined,
  SES_TIMEOUT_MS: 1000,
  trackingBaseUrl: "https://t.example.com",
};
const SECRET = "test-secret-test-secret-test-secret-0123";
const ADMIN = "user:admin-test";
const HTML = `<!DOCTYPE html><html><head><title>T</title></head><body>
<p>Chào {{ greeting_name | default: "bạn" }}</p>
<p><a href="https://shop.example.com/a">Ưu đãi A</a> · <a href="https://shop.example.com/b?x=1&amp;y=2">Ưu đãi B</a> · <a href="mailto:hi@example.com">Mail</a></p>
<!--[if mso]><a href="https://shop.example.com/mso">MSO</a><![endif]-->
<p><a href="{{ unsubscribe_url }}">Hủy đăng ký</a></p></body></html>`;

let db: Db;
let drop: () => Promise<void>;
let templateId: string;
let versionId: string;

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  const t = await createTestDatabase("m7_tracking");
  drop = t.drop;
  db = getDb(t.url);
  const r = await importTemplate(db, { name: "Theo dõi", html: HTML, sourceKind: "paste", actor: "test" });
  const v = await saveSubject(db, { templateId: r.template.id, baseVersionId: r.version.id, subject: "[QC] Theo dõi", actor: "test" });
  templateId = r.template.id;
  versionId = v.id;
});
afterAll(async () => {
  await closeDb();
  await drop();
});

const addr = (p: string, i: number) => `${p}-${i}@example.com`;
class FastLimiter extends RateLimiter {
  constructor() {
    super(100_000);
  }
  override setRate() {}
}

/** n contacts with marketing consent; those in `tracked` also with email_tracking consent. Sent through the mock. */
async function sentCampaign(prefix: string, n: number, o: { tracked?: number[]; mode?: TrackingMode } = {}) {
  await updateSendSettings(db, { trackingMode: o.mode ?? "consented_only", actor: ADMIN, appEnv: "test" });
  const rows = Array.from({ length: n }, (_, i) => ({ notionPageId: `page-${prefix}-${i}`, fullName: `Người ${i}`, email: addr(prefix, i), emailNormalized: addr(prefix, i), emailStatus: "valid" as const, tags: [prefix] }));
  await db.insert(contacts).values(rows);
  await db.insert(consentRecords).values(rows.map((r) => ({ emailNormalized: r.emailNormalized, purpose: "marketing_email" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "T" })));
  const tr = (o.tracked ?? []).map((i) => ({ emailNormalized: addr(prefix, i), purpose: "email_tracking" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "T" }));
  if (tr.length) await db.insert(consentRecords).values(tr);
  const c = await createCampaign(db, { name: `Track ${prefix}`, templateId, templateVersionId: versionId, audience: { kind: "tags", tags: [prefix] }, actor: ADMIN });
  const rv = await reviewCampaign(db, cfg, c.id);
  expect(rv.blocking).toEqual([]);
  await approveAndSendNow(db, { cfg, enqueue: async () => {} }, { campaignId: c.id, expectedRevision: rv.campaign.scheduleRevision, expectedRecipients: n, actor: ADMIN });
  const mock = new MockTransport();
  for (let k = 0; k < 20; k++) if ((await dispatchCampaign(db, { cfg, workerId: "w", mock, limiter: new FastLimiter() }, c.id)).result !== "continue") break;
  const msgs = await db.select().from(messages).where(eq(messages.campaignId, c.id));
  const by = (i: number) => msgs.find((m) => m.emailNormalized === addr(prefix, i))!;
  const html = (i: number) => mock.calls.find((x) => x.to === addr(prefix, i))!.html;
  return { c, msgs, by, html, mock };
}

const after = (m: { sentAt: Date | null }, ms: number) => new Date(m.sentAt!.getTime() + ms);
const req = (now: Date, o: Partial<RequestInfo> = {}): RequestInfo => ({ ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", method: "GET", now, ...o });

describe("tracking at send time (consent and setting)", () => {
  it("consented_only (default): only addresses with tracking consent get rewritten links and the pixel", async () => {
    const s = await sentCampaign("cons", 2, { tracked: [0] });
    const t = s.by(0);
    expect(t.trackingEnabled).toBe(true);
    expect(s.by(1).trackingEnabled).toBe(false);
    expect(s.html(0)).toContain(`href="https://t.example.com/c/${t.trackingToken}/0"`);
    expect(s.html(0)).toContain(`href="https://t.example.com/c/${t.trackingToken}/1"`);
    expect(s.html(0)).toContain(`<img src="https://t.example.com/o/${t.trackingToken}.gif" width="1" height="1" alt=""`);
    expect(s.html(0)).not.toContain('href="https://shop.example.com/a"');
    expect(s.html(0)).toContain('href="mailto:hi@example.com"'); // not a tracked link
    expect(s.html(0)).toContain('<a href="https://shop.example.com/mso">'); // inside an MSO comment: direct
    expect(s.html(0)).toContain(`href="https://t.example.com/u/${t.trackingToken}"`); // unsubscribe untouched
    // untracked recipient: direct links, no pixel, and its token produces no tracking events
    expect(s.html(1)).toContain('href="https://shop.example.com/a"');
    expect(s.html(1)).not.toContain("/o/");
    expect(await recordOpen(db, s.by(1).trackingToken, req(after(s.by(1), 60_000)), SECRET)).toBe(false);
    expect(await recordClick(db, s.by(1).trackingToken, "0", req(after(s.by(1), 60_000)), SECRET)).toBeNull();
    // plain text is never rewritten
    expect(s.mock.calls[0].text).not.toContain("/c/");
  });

  it("mode all tracks everyone; mode off tracks no one", async () => {
    const all = await sentCampaign("modeall", 2, { mode: "all" });
    expect(all.msgs.every((m) => m.trackingEnabled === true)).toBe(true);
    const off = await sentCampaign("modeoff", 2, { mode: "off", tracked: [0, 1] });
    expect(off.msgs.every((m) => m.trackingEnabled === false)).toBe(true);
    expect(off.html(0)).not.toContain("/o/");
  });
});

describe("clicks and opens", () => {
  it("R-TRK-01: three clicks on one link = 1 unique clicker and 3 recorded clicks", async () => {
    const s = await sentCampaign("trk1", 2, { mode: "all" });
    const m = s.by(0);
    for (const k of [1, 2, 3]) expect(await recordClick(db, m.trackingToken, "0", req(after(m, k * 60_000)), SECRET)).toBe("https://shop.example.com/a");
    const links = await linkAnalytics(db, s.c.id);
    expect(links.map((l) => [l.idx, l.url, l.uniqueAll, l.totalAll, l.uniqueFiltered, l.totalFiltered])).toEqual([
      [0, "https://shop.example.com/a", 1, 3, 1, 3],
      [1, "https://shop.example.com/b?x=1&amp;y=2", 0, 0, 0, 0],
    ]);
    const a = await campaignAnalytics(db, s.c.id);
    expect(a.recorded).toMatchObject({ uniqueClickers: 1, totalClicks: 3 });
    expect(a.tracked).toBe(2);
    expect(links[0].first).toEqual(after(m, 60_000));
    expect(links[0].latest).toEqual(after(m, 180_000));
  });

  it("R-TRK-02: a tampered token or link index returns no redirect; the destination is only ever the snapshot URL", async () => {
    const s = await sentCampaign("trk2", 1, { mode: "all" });
    const m = s.by(0);
    const at = req(after(m, 60_000));
    const tampered = (m.trackingToken[0] === "A" ? "B" : "A") + m.trackingToken.slice(1);
    expect(await recordClick(db, tampered, "0", at, SECRET)).toBeNull();
    expect(await recordClick(db, m.trackingToken, "2", at, SECRET)).toBeNull(); // only links 0 and 1 exist
    expect(await recordClick(db, m.trackingToken, "-1", at, SECRET)).toBeNull();
    expect(await recordClick(db, m.trackingToken, "0?url=https://evil.example", at, SECRET)).toBeNull();
    expect(await recordClick(db, m.trackingToken, "1e2", at, SECRET)).toBeNull();
    expect(await recordClick(db, "short", "0", at, SECRET)).toBeNull();
    expect(await recordOpen(db, tampered, at, SECRET)).toBe(false);
    const url = await recordClick(db, m.trackingToken, "1", at, SECRET);
    const stored = (await db.select().from(campaignLinks).where(and(eq(campaignLinks.snapshotId, m.snapshotId), eq(campaignLinks.idx, 1))))[0].url;
    expect(url).toBe(stored);
    expect(await db.select().from(messageEvents).where(and(eq(messageEvents.messageId, m.id), eq(messageEvents.type, "click")))).toHaveLength(1);
  });

  it("R-TRK-03: automated activity is flagged; recorded and filtered counts are both available", async () => {
    const s = await sentCampaign("trk3", 4, { mode: "all" });
    const [m0, m1, m2, m3] = [0, 1, 2, 3].map(s.by);
    // m0: a link scanner (UA) and a HEAD pre-check, then a real click a minute later
    expect(await recordClick(db, m0.trackingToken, "0", req(after(m0, 30_000), { userAgent: "Mozilla/5.0 (compatible; Barracuda Sentinel)" }), SECRET)).toBeTruthy();
    expect(await recordClick(db, m0.trackingToken, "0", req(after(m0, 31_000), { method: "HEAD" }), SECRET)).toBeTruthy();
    // m1: clicked 3 s after sending (fast click)
    await recordClick(db, m1.trackingToken, "0", req(after(m1, 3_000)), SECRET);
    // m2: two different links within 1 s (burst: both flagged, including the earlier one)
    await recordClick(db, m2.trackingToken, "0", req(after(m2, 60_000)), SECRET);
    await recordClick(db, m2.trackingToken, "1", req(after(m2, 61_000)), SECRET);
    // m3: a normal open through Google's image proxy (labelled, NOT automated) and a normal click
    await recordOpen(db, m3.trackingToken, req(after(m3, 90_000), { userAgent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)" }), SECRET);
    await recordClick(db, m3.trackingToken, "1", req(after(m3, 120_000)), SECRET);
    // an open with no user agent at all (automated)
    await recordOpen(db, m1.trackingToken, req(after(m1, 5_000), { userAgent: null }), SECRET);

    const ev = await db.select().from(messageEvents).where(inArray(messageEvents.messageId, [m0.id, m1.id, m2.id, m3.id]));
    const flagsOf = (id: string, type: string) => ev.filter((e) => e.messageId === id && e.type === type).map((e) => [e.flags.sort().join(","), e.suspectedAutomated]);
    expect(flagsOf(m0.id, "click").sort()).toEqual([
      ["head_request", true],
      ["scanner_ua", true],
    ]);
    expect(flagsOf(m1.id, "click")).toEqual([["fast_click", true]]);
    expect(flagsOf(m1.id, "open")).toEqual([["no_user_agent", true]]);
    expect(flagsOf(m2.id, "click")).toEqual([
      ["multi_link_burst", true],
      ["multi_link_burst", true],
    ]);
    expect(flagsOf(m3.id, "open")).toEqual([["proxy_open", false]]);
    expect(flagsOf(m3.id, "click")).toEqual([["", false]]);

    const a = await campaignAnalytics(db, s.c.id);
    // unique openers include implied opens (a click without a recorded open): CTOR never exceeds 100%
    expect(a.recorded).toEqual({ uniqueOpeners: 4, totalOpens: 2, uniqueClickers: 4, totalClicks: 6 });
    expect(a.filtered).toEqual({ uniqueOpeners: 1, totalOpens: 1, uniqueClickers: 1, totalClicks: 1 });
    expect(rate(a.recorded.uniqueClickers, a.recorded.uniqueOpeners)).toBe("100.0%");
    expect(a.automatedEvents).toBe(6);
    // stored privacy: the IP is never stored, only a keyed hash; the UA is truncated
    expect(ev.every((e) => e.ipHash !== "203.0.113.7" && /^[0-9a-f]{32}$/.test(e.ipHash ?? ""))).toBe(true);
  });

  it("rates use Delivered (with Sent alongside) and CTOR = unique clickers / unique openers", async () => {
    const s = await sentCampaign("rate", 4, { mode: "all" });
    for (const i of [0, 1, 2]) {
      const m = s.by(i);
      await ingestSesEvent(db, `sns-rate-${i}`, { eventType: "Delivery", mail: { messageId: `p-${i}`, timestamp: m.sentAt!.toISOString(), tags: { msg_id: [m.id] } }, delivery: { timestamp: m.sentAt!.toISOString() } });
    }
    for (const i of [0, 1]) await recordOpen(db, s.by(i).trackingToken, req(after(s.by(i), 120_000)), SECRET);
    await recordClick(db, s.by(0).trackingToken, "0", req(after(s.by(0), 180_000)), SECRET);
    const a = await campaignAnalytics(db, s.c.id);
    expect([a.counts.sent, a.counts.delivered]).toEqual([4, 3]);
    expect(rate(a.filtered.uniqueOpeners, a.counts.delivered)).toBe("66.7%");
    expect(rate(a.filtered.uniqueOpeners, a.counts.sent)).toBe("50.0%");
    expect(rate(a.filtered.uniqueClickers, a.filtered.uniqueOpeners)).toBe("50.0%");
    expect(rate(1, 0)).toBe("—");
    // a delivery event 2 minutes before a click means the click is not "fast"
    expect((await db.select().from(messageEvents).where(and(eq(messageEvents.messageId, s.by(0).id), eq(messageEvents.type, "click"))))[0].flags).toEqual([]);
  });

  it("engagement updates last_engagement_at only for non-automated activity; the timeline shows first and latest activity", async () => {
    const s = await sentCampaign("eng", 2, { mode: "all" });
    const m = s.by(0);
    await recordClick(db, m.trackingToken, "0", req(after(m, 60_000), { userAgent: "python-requests/2.32" }), SECRET);
    const c0 = (await db.select().from(contacts).where(eq(contacts.notionPageId, "page-eng-0")))[0];
    expect(c0.lastEngagementAt).toBeNull();
    await recordOpen(db, m.trackingToken, req(after(m, 120_000)), SECRET);
    await recordClick(db, m.trackingToken, "1", req(after(m, 180_000)), SECRET);
    await unsubscribeByToken(db, m.trackingToken, { method: "one_click", clock: new FixedClock(after(m, 240_000)) });
    expect((await db.select().from(contacts).where(eq(contacts.notionPageId, "page-eng-0")))[0].lastEngagementAt).toEqual(after(m, 180_000));
    const tl = (await recipientTimeline(db, s.c.id, m.id))!;
    expect(tl.events.map((e) => e.type)).toEqual(["send attempt", "sent", "click", "open", "click", "unsubscribe"]);
    expect(tl.events.find((e) => e.type === "click")!.flags).toEqual(["scanner_ua"]);
    expect(tl.firstActivity).toEqual(after(m, 60_000));
    expect(tl.latestActivity).toEqual(after(m, 180_000));
    expect((await campaignAnalytics(db, s.c.id)).unsubscribes).toBe(1);
    expect(await recipientTimeline(db, s.c.id, randomUUID())).toBeNull();
  });
});

describe("R-PERS-04 (completes M4): test sends never count in campaign metrics", () => {
  it("a test send carries no tracking links or pixel and produces no campaign events", async () => {
    const s = await sentCampaign("pers4", 1, { mode: "all" });
    const before = await campaignAnalytics(db, s.c.id);
    const mock = new MockTransport();
    const out = await sendTestEmail(
      db,
      { cfg: { ...cfg, TEST_SEND_MAX_PER_HOUR: 10, TEST_SEND_MAX_PER_DAY: 50 }, mock },
      { templateId, versionId, recipients: "qa-inbox@example.com", mergeSource: "sample-full", idempotencyKey: randomUUID(), actor: ADMIN },
    );
    expect(out[0].status).toBe("accepted");
    expect(mock.calls[0].html).not.toMatch(/\/o\/|\/c\//);
    expect(await db.select().from(messageEvents).where(eq(messageEvents.testSendId, out[0].id))).toHaveLength(0);
    expect((await db.select().from(testSends).where(eq(testSends.id, out[0].id)))[0]).not.toHaveProperty("campaignId");
    expect(await campaignAnalytics(db, s.c.id)).toEqual(before);
  });
});
