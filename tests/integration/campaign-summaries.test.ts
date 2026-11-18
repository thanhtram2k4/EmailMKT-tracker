/**
 * M8 integration tests: Notion campaign summaries and the contacts' engagement write-back, against
 * REAL PostgreSQL and the FAKE Notion API (virtual time; no network, no real Notion). MOCK.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campaignNotionSummaries, consentRecords, contacts, messages, notionConnection, notionOutbox } from "../../src/lib/db/schema";
import { dispatchCampaign, RateLimiter, type DispatchConfig } from "../../src/lib/campaigns/dispatcher";
import { approveAndSendNow, createCampaign, reviewCampaign, type CampaignConfig } from "../../src/lib/campaigns/service";
import { updateSendSettings } from "../../src/lib/campaigns/settings";
import { recordOpen } from "../../src/lib/campaigns/tracking";
import { createCampaignsDatabase, dueStage, queueEngagementWrites, writeCampaignSummaries } from "../../src/lib/crm/campaign-summaries";
import { flushOutbox } from "../../src/lib/crm/outbox";
import { syncContacts } from "../../src/lib/crm/sync";
import { MockTransport } from "../../src/lib/sending/transport";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { MOCK_PARENT_PAGE_ID } from "../../scripts/notion-mock/seed";
import { setupCrm, type CrmCtx } from "./crm-helpers";

const cfg: DispatchConfig & CampaignConfig = {
  APP_ENV: "test",
  SEND_MODE: "mock",
  TEST_RECIPIENT_ALLOWLIST: [],
  SEND_AUTHORIZATION_REF: undefined,
  SES_REGION: "ap-southeast-1",
  SES_FROM_ADDRESS: undefined,
  SES_CONFIGURATION_SET: undefined,
  SES_TIMEOUT_MS: 1000,
  trackingBaseUrl: "https://t.example.com",
};
const ADMIN = "user:admin-test";
class FastLimiter extends RateLimiter {
  constructor() {
    super(100_000);
  }
  override setRate() {}
}

let ctx: CrmCtx;
let templateId: string;
let versionId: string;
let emails: string[] = [];

beforeAll(async () => {
  ctx = await setupCrm({ pages: "synthetic" });
  const s = await syncContacts(ctx.db, ctx.env, { mode: "full", trigger: "test", actor: "test" });
  expect(s.status).toBe("succeeded");
  // Grant marketing consent to the first 3 eligible synthetic contacts (valid, non-duplicate, not suppressed).
  const rows = await ctx.db.execute(`
    select c.email_normalized from contacts c
    where c.state = 'active' and c.email_status = 'valid' and not c.is_duplicate
      and not exists (select 1 from suppressions s where s.email_normalized = c.email_normalized)
    order by c.email_normalized limit 3`);
  emails = (rows.rows as Array<{ email_normalized: string }>).map((r) => r.email_normalized);
  await ctx.db.insert(consentRecords).values(emails.map((e) => ({ emailNormalized: e, purpose: "marketing_email" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "T" })));
  await ctx.db.update(contacts).set({ tags: ["m8-summary"] }).where(inArray(contacts.emailNormalized, emails));
  const r = await importTemplate(ctx.db, { name: "Tóm tắt", html: '<p>Hi</p><p><a href="https://shop.example.com/x">X</a></p><a href="{{ unsubscribe_url }}">U</a>', sourceKind: "paste", actor: "test" });
  const v = await saveSubject(ctx.db, { templateId: r.template.id, baseVersionId: r.version.id, subject: "[QC] Tóm tắt", actor: "test" });
  templateId = r.template.id;
  versionId = v.id;
});
afterAll(async () => {
  await ctx.drop();
});

async function sendCampaign(name: string) {
  const c = await createCampaign(ctx.db, { name, templateId, templateVersionId: versionId, audience: { kind: "tags", tags: ["m8-summary"] }, actor: ADMIN });
  const rv = await reviewCampaign(ctx.db, cfg, c.id);
  expect(rv.blocking).toEqual([]);
  await approveAndSendNow(ctx.db, { cfg, enqueue: async () => {} }, { campaignId: c.id, expectedRevision: rv.campaign.scheduleRevision, expectedRecipients: emails.length, actor: ADMIN });
  for (let k = 0; k < 10; k++) if ((await dispatchCampaign(ctx.db, { cfg, workerId: "w", mock: new MockTransport(), limiter: new FastLimiter() }, c.id)).result !== "continue") break;
  const row = (await ctx.db.execute(`select status::text as s, finished_at from campaigns where id = '${c.id}'`)).rows[0] as { s: string; finished_at: string };
  expect(row.s).toBe("completed");
  return { id: c.id, finishedAt: new Date(row.finished_at) };
}

const pagesIn = (dsId: string) => [...ctx.fake.pages.values()].filter((p) => p.dataSourceId === dsId);
const prop = (p: { properties: Record<string, unknown> }, name: string) => p.properties[name] as Record<string, unknown>;

describe("stages", () => {
  it("dueStage picks the latest due stage not written yet", () => {
    const f = new Date("2026-11-01T00:00:00Z");
    const at = (h: number) => new Date(f.getTime() + h * 3600_000);
    expect(dueStage(f, [], at(0))?.key).toBe("completion");
    expect(dueStage(f, ["completion"], at(23))).toBeNull();
    expect(dueStage(f, ["completion"], at(24))?.key).toBe("24h");
    expect(dueStage(f, ["completion"], at(100))?.key).toBe("72h"); // a missed 24 h stage is covered by 72 h
    expect(dueStage(f, ["completion", "24h", "72h"], at(24 * 7))?.key).toBe("7d");
    expect(dueStage(f, ["completion", "24h", "72h", "7d"], at(24 * 30))).toBeNull();
  });
});

describe("Notion campaign summaries (FAKE Notion)", () => {
  let dsId = "";

  it("are skipped until an Email Campaigns database exists; creating one uses the stored connection", async () => {
    expect(await writeCampaignSummaries(ctx.db, ctx.env)).toMatchObject({ configured: false, written: 0 });
    expect(await createCampaignsDatabase(ctx.db, ctx.env, { parentPageIdOrUrl: "not a page", actor: ADMIN })).toMatchObject({ ok: false });
    const r = await createCampaignsDatabase(ctx.db, ctx.env, { parentPageIdOrUrl: MOCK_PARENT_PAGE_ID, actor: ADMIN });
    expect(r).toMatchObject({ ok: true });
    dsId = (await ctx.db.select().from(notionConnection))[0].campaignsDataSourceId!;
    expect(dsId).toBeTruthy();
    expect(await createCampaignsDatabase(ctx.db, ctx.env, { parentPageIdOrUrl: MOCK_PARENT_PAGE_ID, actor: ADMIN })).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });

  it("writes one page per campaign at completion and rewrites the same page at later stages", async () => {
    const c = await sendCampaign("Bản tin tóm tắt");
    const w1 = await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 1000) });
    expect(w1).toMatchObject({ configured: true, written: 1, failed: 0 });
    let pages = pagesIn(dsId);
    expect(pages).toHaveLength(1);
    const p = pages[0];
    expect((prop(p, "Campaign ID").rich_text as Array<{ plain_text: string }>)[0].plain_text).toBe(c.id);
    expect((prop(p, "Name").title as Array<{ plain_text: string }>)[0].plain_text).toBe("Bản tin tóm tắt");
    expect(prop(p, "Sent").number).toBe(emails.length);
    expect(prop(p, "Recipients").number).toBe(emails.length);
    expect(prop(p, "Summary stage").select).toEqual({ name: "On completion" });
    expect(prop(p, "Open rate (of Delivered)").number).toBeNull(); // no Delivery events locally
    // nothing new is due a minute later
    expect((await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 60_000) })).written).toBe(0);
    // +25 h: the 24 h stage rewrites the SAME page
    expect((await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 25 * 3600_000) })).written).toBe(1);
    pages = pagesIn(dsId);
    expect(pages).toHaveLength(1);
    expect(prop(pages[0], "Summary stage").select).toEqual({ name: "+24 h" });
    // +8 days: the remaining stages are covered by one write; afterwards nothing is due
    expect((await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 8 * 24 * 3600_000) })).written).toBe(1);
    const s = (await ctx.db.select().from(campaignNotionSummaries).where(eq(campaignNotionSummaries.campaignId, c.id)))[0];
    expect(s.stagesDone).toEqual(["completion", "24h", "72h", "7d"]);
    expect(prop(pagesIn(dsId)[0], "Summary stage").select).toEqual({ name: "+7 days" });
    expect((await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 30 * 24 * 3600_000) })).written).toBe(0);
  });

  it("an uncertain create (applied, then failed) does not produce a second page: the next run finds it", async () => {
    const c = await sendCampaign("Bản tin không chắc");
    const before = pagesIn(dsId).length;
    ctx.fake.faults.push({ method: "POST", pathIncludes: "/v1/pages", applyThenFail: true, status: 503, times: 1 });
    const w1 = await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 1000) });
    expect(w1).toMatchObject({ written: 0, failed: 1 });
    expect(pagesIn(dsId)).toHaveLength(before + 1); // Notion did create it
    const s1 = (await ctx.db.select().from(campaignNotionSummaries).where(eq(campaignNotionSummaries.campaignId, c.id)))[0];
    expect(s1.notionPageId).toBeNull();
    expect(s1.lastError).toBeTruthy();
    const w2 = await writeCampaignSummaries(ctx.db, ctx.env, { now: new Date(c.finishedAt.getTime() + 300_000) });
    expect(w2).toMatchObject({ written: 1, failed: 0 });
    expect(pagesIn(dsId)).toHaveLength(before + 1); // adopted, not duplicated
    const s2 = (await ctx.db.select().from(campaignNotionSummaries).where(eq(campaignNotionSummaries.campaignId, c.id)))[0];
    expect(s2.notionPageId).toBeTruthy();
    expect(s2.lastError).toBeNull();
    // exactly one page per summarized campaign (the fake logs an apply-then-fail request twice, so count pages, not requests)
    expect(pagesIn(dsId)).toHaveLength(2);
  });
});

describe("contacts' Last emailed / Last engagement write-back (FAKE Notion)", () => {
  it("queues only changed contacts, writes absolute dates, and re-queues after new engagement", async () => {
    // Earlier tests sent campaigns: these contacts have last_emailed_at.
    const n1 = await queueEngagementWrites(ctx.db, ctx.env);
    expect(n1).toBe(emails.length);
    expect(await queueEngagementWrites(ctx.db, ctx.env)).toBe(0); // nothing changed since
    const f = await flushOutbox(ctx.db, ctx.env);
    expect(f.failed).toBe(0);
    const c0 = (await ctx.db.select().from(contacts).where(eq(contacts.emailNormalized, emails[0])))[0];
    const page = ctx.fake.pages.get(c0.notionPageId)!;
    expect((page.properties["Last emailed"] as { date: { start: string } }).date.start).toBe(c0.lastEmailedAt!.toISOString());
    expect((page.properties["Last engagement"] as { date: unknown }).date).toBeNull();
    // A human open (tracking mode all for this send) sets last_engagement_at → queued again
    await updateSendSettings(ctx.db, { trackingMode: "all", actor: ADMIN, appEnv: "test" });
    const c = await sendCampaign("Bản tin theo dõi");
    const m = (await ctx.db.select().from(messages).where(eq(messages.campaignId, c.id))).find((x) => x.emailNormalized === emails[0])!;
    expect(await recordOpen(ctx.db, m.trackingToken, { ip: "203.0.113.9", userAgent: "Mozilla/5.0 Chrome/130", method: "GET", now: new Date(Date.now() + 120_000) }, "s")).toBe(true);
    expect(await queueEngagementWrites(ctx.db, ctx.env)).toBe(emails.length); // all were emailed again; one also engaged
    await flushOutbox(ctx.db, ctx.env);
    const after = ctx.fake.pages.get(c0.notionPageId)!;
    expect((after.properties["Last engagement"] as { date: { start: string } }).date.start).toBeTruthy();
    expect(await ctx.db.select().from(notionOutbox).where(eq(notionOutbox.status, "failed"))).toHaveLength(0);
  });
});
