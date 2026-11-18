/**
 * M8 restore drill: export a populated database (real flows: Notion sync with the FAKE Notion, a sent
 * campaign with tracking events, an unsubscribe, a scheduled campaign) and restore it into a fresh,
 * migrated database. MOCK data; real PostgreSQL. Evidence for docs/RUNBOOK.md "Restore drill".
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/lib/db/schema";
import { campaignAnalytics } from "../../src/lib/campaigns/analytics";
import { dispatchCampaign, RateLimiter, type DispatchConfig } from "../../src/lib/campaigns/dispatcher";
import { scheduleCampaign } from "../../src/lib/campaigns/schedule";
import { localParts } from "../../src/lib/campaigns/schedule-time";
import { approveAndSendNow, createCampaign, reviewCampaign, type CampaignConfig } from "../../src/lib/campaigns/service";
import { updateSendSettings } from "../../src/lib/campaigns/settings";
import { recordClick, recordOpen } from "../../src/lib/campaigns/tracking";
import { unsubscribeByToken } from "../../src/lib/campaigns/unsubscribe";
import { FixedClock } from "../../src/lib/clock";
import { clientForConnection } from "../../src/lib/crm/notion-env";
import { syncContacts } from "../../src/lib/crm/sync";
import type { Db } from "../../src/lib/db/client";
import { exportDatabase, restoreDatabase, RestoreRefused, verifyRestore } from "../../src/lib/ops/backup";
import { MockTransport } from "../../src/lib/sending/transport";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { setupCrm, type CrmCtx } from "./crm-helpers";
import { createTestDatabase } from "./helpers";

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
class FastLimiter extends RateLimiter {
  constructor() {
    super(100_000);
  }
  override setRate() {}
}

let a: CrmCtx;
let b: Awaited<ReturnType<typeof createTestDatabase>>;
let bClient: pg.Client;
let bDb: Db;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  a = await setupCrm({ pages: "synthetic" });
  expect((await syncContacts(a.db, a.env, { mode: "full", trigger: "test", actor: "test" })).status).toBe("succeeded");
  const emails = (
    (await a.db.execute(`select email_normalized from contacts where state = 'active' and email_status = 'valid' and not is_duplicate
                        and not exists (select 1 from suppressions s where s.email_normalized = contacts.email_normalized) order by 1 limit 4`)).rows as Array<{ email_normalized: string }>
  ).map((r) => r.email_normalized);
  await a.db.insert(schema.consentRecords).values(emails.map((e) => ({ emailNormalized: e, purpose: "marketing_email" as const, status: "granted" as const, source: "staff_entry" as const, recordedBy: "test", evidenceRef: "DRILL" })));
  await a.db.update(schema.contacts).set({ tags: ["drill"] }).where(inArray(schema.contacts.emailNormalized, emails));
  await updateSendSettings(a.db, { trackingMode: "all", actor: "test", appEnv: "test" });
  const t = await importTemplate(a.db, { name: "Diễn tập", html: '<p>Chào {{ greeting_name | default: "bạn" }}</p><p><a href="https://shop.example.com/d">D</a></p><a href="{{ unsubscribe_url }}">U</a>', sourceKind: "paste", actor: "test" });
  const v = await saveSubject(a.db, { templateId: t.template.id, baseVersionId: t.version.id, subject: "[QC] Diễn tập khôi phục", actor: "test" });
  const c = await createCampaign(a.db, { name: "Diễn tập", templateId: t.template.id, templateVersionId: v.id, audience: { kind: "tags", tags: ["drill"] }, actor: "user:admin" });
  const rv = await reviewCampaign(a.db, cfg, c.id);
  await approveAndSendNow(a.db, { cfg, enqueue: async () => {} }, { campaignId: c.id, expectedRevision: rv.campaign.scheduleRevision, expectedRecipients: emails.length, actor: "user:admin" });
  for (let k = 0; k < 10; k++) if ((await dispatchCampaign(a.db, { cfg, workerId: "w", mock: new MockTransport(), limiter: new FastLimiter() }, c.id)).result !== "continue") break;
  campaignId = c.id;
  const ms = await a.db.select().from(schema.messages).where(eq(schema.messages.campaignId, c.id));
  const later = (ms0: (typeof ms)[number], s: number) => ({ ip: "203.0.113.5", userAgent: "Mozilla/5.0 Chrome/130", method: "GET", now: new Date(ms0.sentAt!.getTime() + s * 1000) });
  await recordOpen(a.db, ms[0].trackingToken, later(ms[0], 60), "k");
  await recordClick(a.db, ms[0].trackingToken, "0", later(ms[0], 90), "k");
  await unsubscribeByToken(a.db, ms[1].trackingToken, { method: "one_click" });
  // a scheduled campaign (draft → scheduled) so schedule columns and a second snapshot are included
  const c2 = await createCampaign(a.db, { name: "Lịch diễn tập", templateId: t.template.id, templateVersionId: v.id, audience: { kind: "tags", tags: ["drill"] }, actor: "user:admin" });
  const when = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 60_000) * 60_000);
  const rv2 = await reviewCampaign(a.db, cfg, c2.id);
  await scheduleCampaign(a.db, { cfg, enqueue: async () => {}, clock: new FixedClock(new Date(when.getTime() - 3600_000)) }, {
    campaignId: c2.id,
    expectedRevision: rv2.campaign.scheduleRevision,
    expectedRecipients: rv2.resolved.included.length,
    actor: "user:admin",
    ...localParts(when, "Asia/Ho_Chi_Minh"),
    zone: "Asia/Ho_Chi_Minh",
  });

  dir = mkdtempSync(path.join(os.tmpdir(), "emt-backup-"));
  b = await createTestDatabase("it_restore");
  bClient = new pg.Client({ connectionString: b.url });
  await bClient.connect();
  bDb = drizzle(bClient, { schema }) as unknown as Db;
});
afterAll(async () => {
  await bClient.end();
  await b.drop();
  await a.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("restore drill", () => {
  it("exports every table with counts and checksums", async () => {
    const m = await exportDatabase(a.db.$client as unknown as pg.ClientBase, dir);
    const byName = Object.fromEntries(m.tables.map((t) => [t.name, t.rows]));
    const count = async (t: string) => Number(((await a.db.execute(`select count(*)::int as n from ${t}`)).rows[0] as { n: number }).n);
    for (const t of ["contacts", "messages", "message_events", "suppressions", "consent_records", "campaign_snapshots"]) expect(byName[t], t).toBe(await count(t));
    expect(byName.contacts).toBeGreaterThanOrEqual(39);
    expect(byName.messages).toBe(7); // 4 sent + 3 scheduled (one recipient unsubscribed before the second approval)
    expect(byName.message_events).toBeGreaterThanOrEqual(3); // open, click, unsubscribe
    expect(byName.notion_connection).toBe(1);
    expect(byName.audit_log).toBeGreaterThan(5);
    // FK order: parents before children
    const order = m.tables.map((t) => t.name);
    expect(order.indexOf("campaigns")).toBeLessThan(order.indexOf("campaign_snapshots"));
    expect(order.indexOf("campaign_snapshots")).toBeLessThan(order.indexOf("messages"));
    expect(order.indexOf("sync_runs")).toBeLessThan(order.indexOf("sync_issues"));
    expect(m.migrations).toBeGreaterThanOrEqual(13);
  });

  it("restores into a fresh migrated database; every table matches; the app works on it", async () => {
    const r = await restoreDatabase(bClient, dir);
    expect(r.tables).toBeGreaterThan(20);
    expect(await verifyRestore(bClient, dir)).toEqual([]);
    // Same analytics computed on the restored copy.
    expect(await campaignAnalytics(bDb, campaignId)).toEqual(await campaignAnalytics(a.db, campaignId));
    // The encrypted Notion token still decrypts with the same key (the key is NOT in the backup).
    expect(await clientForConnection(bDb, a.env)).not.toBeNull();
    // Append-only rules survive the restore.
    await expect(bClient.query("delete from suppressions")).rejects.toThrow(/append-only/);
    await expect(bClient.query("update audit_log set actor = 'x'")).rejects.toThrow(/append-only|not allowed/);
    // Sequences moved past restored ids: new rows get fresh ids.
    await bClient.query(`insert into audit_log (actor, action) values ('test', 'restore.drill')`);
    const ids = (await bClient.query(`select count(*)::int as n, count(distinct id)::int as d from audit_log`)).rows[0];
    expect(ids.n).toBe(ids.d);
  });

  it("refuses a non-empty target; a corrupted backup file is detected after restore", async () => {
    await expect(restoreDatabase(bClient, dir)).rejects.toThrow(RestoreRefused);
    // The drill above added one audit row to B, so B now differs from the backup in exactly that table.
    expect((await verifyRestore(bClient, dir)).map((x) => x.table)).toEqual(["audit_log"]);
    // Corrupt one file and restore it into a third, fresh database: verification names that table.
    const f = path.join(dir, "suppressions.jsonl");
    writeFileSync(f, readFileSync(f, "utf8").replace(/"note":null/, '"note":"tampered"'));
    const c = await createTestDatabase("it_restore_bad");
    const cc = new pg.Client({ connectionString: c.url });
    await cc.connect();
    try {
      await restoreDatabase(cc, dir);
      expect((await verifyRestore(cc, dir)).map((x) => x.table)).toEqual(["suppressions"]);
    } finally {
      await cc.end();
      await c.drop();
    }
  });
});
