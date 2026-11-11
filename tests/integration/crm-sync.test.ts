/**
 * M2 integration tests: Notion → contacts sync against REAL PostgreSQL and the FAKE Notion API
 * (MOCK — proves our sync logic; does not prove behaviour of the live Notion service).
 * IDs R-SYNC-01..06 refer to docs/PLAN.md acceptance criteria.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createCrmDatabase, connectExistingDatabase } from "../../src/lib/crm/connection";
import { currentConsent } from "../../src/lib/crm/consent";
import { syncContacts } from "../../src/lib/crm/sync";
import { auditLog, consentRecords, contacts, notionConnection, notionOutbox, suppressions, syncIssues, syncRuns, syncState } from "../../src/lib/db/schema";
import { flushOutbox } from "../../src/lib/crm/outbox";
import { crmPageProperties } from "../../scripts/notion-mock/fake-notion";
import { SYNTHETIC_CONTACTS } from "../../scripts/notion-mock/synthetic-contacts";
import { addGeneratedPages, setupCrm, type CrmCtx } from "./crm-helpers";

let ctx: CrmCtx | undefined;
afterEach(async () => {
  await ctx?.drop();
  ctx = undefined;
});

const full = (c: CrmCtx, extra: Partial<Parameters<typeof syncContacts>[2]> = {}) => syncContacts(c.db, c.env, { mode: "full", trigger: "test", actor: "test", ...extra });
const incr = (c: CrmCtx, extra: Partial<Parameters<typeof syncContacts>[2]> = {}) => syncContacts(c.db, c.env, { mode: "incremental", trigger: "test", actor: "test", ...extra });
const byPage = async (c: CrmCtx, key: string) => (await c.db.select().from(contacts).where(eq(contacts.notionPageId, c.pageIds[key])))[0];
const count = async (c: CrmCtx, table: string) => ((await c.db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0] as { n: number }).n;

describe("synthetic CRM import", () => {
  it("imports the 40 synthetic contacts with validation, duplicates, suppressions and unknown consent", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    const r = await full(ctx);
    expect(r.status).toBe("succeeded");
    const nonTrashed = SYNTHETIC_CONTACTS.filter((s) => !s.inTrash).length;
    expect(r.counts).toMatchObject({ fetched: nonTrashed, created: nonTrashed, invalidEmail: 5, missingEmail: 1, duplicateContacts: 5, suppressionsAdded: 4 });

    // NFD input stored as NFC
    expect((await byPage(ctx, "ha-nfd")).fullName).toBe("Phạm Thị Thu Hà");
    // duplicates differing only in case/whitespace
    const mai2 = await byPage(ctx, "mai-2");
    expect(mai2).toMatchObject({ emailNormalized: "mai.ngo@example.com", isDuplicate: true });
    expect((await byPage(ctx, "khang-3")).isDuplicate).toBe(true);
    expect((await byPage(ctx, "an")).isDuplicate).toBe(false);
    // invalid and missing addresses
    expect(await byPage(ctx, "son")).toMatchObject({ emailStatus: "invalid", emailInvalidReason: "non_ascii" });
    expect(await byPage(ctx, "nga")).toMatchObject({ emailStatus: "missing", emailNormalized: null });
    // missing greeting names flagged (whitespace-only counts as missing)
    for (const k of ["phuc", "thu", "hieu", "khang-3", "noname"]) expect((await byPage(ctx, k)).issues).toContain("greeting_name_missing");
    // tags normalized
    expect((await byPage(ctx, "vy")).tags).toEqual(["Dữ liệu mẫu", "Khách hàng"]);

    // Suppressions from Notion values; consent withdrawn for those
    const sup = await ctx.db.select().from(suppressions);
    expect(sup.map((s) => s.emailNormalized).sort()).toEqual(["huy.bui@example.com", "linh.phan@example.com", "tram.ho@example.org", "tung.duong@example.net"]);
    expect(sup.every((s) => s.reason === "notion_unsubscribed" && s.source === "notion_sync")).toBe(true);
    expect((await currentConsent(ctx.db, "linh.phan@example.com")).marketing_email).toBe("withdrawn");

    // Import never grants consent; evidence references are kept but status stays unknown
    const granted = await ctx.db.select().from(consentRecords).where(eq(consentRecords.status, "granted"));
    expect(granted).toHaveLength(0);
    const an = (await ctx.db.select().from(consentRecords).where(eq(consentRecords.emailNormalized, "an.nguyen@congty-anphat.example")))[0];
    expect(an).toMatchObject({ status: "unknown", source: "notion_import", evidenceRef: "Form đăng ký 2026-03-02 #F-1021" });
    expect((await currentConsent(ctx.db, "ngoc.tran@example.com")).marketing_email).toBe("unknown");
  });

  it("R-SYNC-01: repeated syncs create no duplicate contacts, consent or suppression rows", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    await full(ctx);
    const before = { c: await count(ctx, "contacts"), cr: await count(ctx, "consent_records"), s: await count(ctx, "suppressions") };
    const r2 = await full(ctx);
    const r3 = await incr(ctx);
    expect(r2.status).toBe("succeeded");
    expect(r2.counts).toMatchObject({ created: 0, updated: 0, suppressionsAdded: 0, outboxQueued: 0 });
    expect(r2.counts.unchanged).toBe(before.c);
    expect(r3.counts.created).toBe(0);
    expect({ c: await count(ctx, "contacts"), cr: await count(ctx, "consent_records"), s: await count(ctx, "suppressions") }).toEqual(before);
  });
});

describe("pagination, query cap and incremental cursor", () => {
  it("paginates 250 pages at page_size 100", async () => {
    ctx = await setupCrm();
    addGeneratedPages(ctx, 250);
    const r = await full(ctx);
    expect(r).toMatchObject({ status: "succeeded" });
    expect(r.counts).toMatchObject({ fetched: 250, created: 250, queryPages: 3 });
    const bodies = ctx.fake.requests.filter((x) => x.path.endsWith("/query")).map((x) => x.body as { page_size: number; start_cursor?: string });
    expect(bodies.every((b) => b.page_size === 100)).toBe(true);
    expect(bodies.filter((b) => b.start_cursor)).toHaveLength(2);
  });

  it("continues past the per-query result cap in time-ordered chunks", async () => {
    ctx = await setupCrm({ fake: { maxQueryResults: 120 } });
    addGeneratedPages(ctx, 250);
    const r = await full(ctx);
    expect(r.status).toBe("succeeded");
    expect(r.counts.fetched).toBe(250);
    expect(r.counts.queryChunks).toBeGreaterThanOrEqual(3);
    expect(await count(ctx, "contacts")).toBe(250);
  });

  it("treats a capped listing without timestamp progress as incomplete and does not archive", async () => {
    ctx = await setupCrm({ fake: { maxQueryResults: 50 } });
    addGeneratedPages(ctx, 30, 61_000);
    await full(ctx); // 30 contacts known
    // 80 more pages all edited in the same minute → cap of 50 cannot make progress
    addGeneratedPages(ctx, 80, 10, (i) => ({ name: `Cùng phút ${i}`, email: `same.minute.${i}@example.org` }));
    for (const id of [...ctx.fake.pages.keys()].slice(0, 30)) ctx.fake.removePage(id); // would be archived by a complete listing
    const r = await full(ctx);
    expect(r).toMatchObject({ status: "partial", errorCode: "query_cap_no_progress" });
    expect(r.counts.archivedMissing).toBe(0);
    expect(await ctx.db.select().from(contacts).where(eq(contacts.state, "archived"))).toHaveLength(0);
  });

  it("incremental sync filters on last_edited_time with a 5-minute overlap and catches same-minute edits", async () => {
    ctx = await setupCrm();
    const ids = addGeneratedPages(ctx, 20);
    const r1 = await full(ctx);
    expect(r1.cursorAfter).not.toBeNull();
    // An edit 20 s later lands in the SAME rounded minute as the cursor.
    ctx.time.advance(20_000);
    ctx.fake.editPage(ids[19], crmPageProperties({ name: "Tên đã sửa", greeting: "Bạn 19", email: "gen.19@example.com" }));
    const r2 = await incr(ctx);
    expect(r2.status).toBe("succeeded");
    expect(r2.counts.updated).toBe(1);
    expect(r2.counts.fetched).toBeLessThan(20); // only the overlap window was read
    const lastQuery = ctx.fake.requests.filter((x) => x.path.endsWith("/query")).at(-1)!.body as { filter: { last_edited_time: { on_or_after: string } } };
    expect(Date.parse(lastQuery.filter.last_edited_time.on_or_after)).toBe(r1.cursorAfter!.getTime() - 5 * 60_000);
    expect((await ctx.db.select().from(contacts).where(eq(contacts.notionPageId, ids[19])))[0].fullName).toBe("Tên đã sửa");
  });
});

describe("identity, archiving and email changes", () => {
  it("R-SYNC-03: an email change keeps the same contact; the old suppressed address stays suppressed and is flagged", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    await full(ctx);
    const before = await byPage(ctx, "huy");
    ctx.time.advance(120_000);
    ctx.fake.editPage(ctx.pageIds.huy, crmPageProperties({ name: "Bùi Đức Huy", greeting: "Anh Huy", email: "huy.moi@example.com", subscription: "Subscribed" }));
    await incr(ctx);
    const after = await byPage(ctx, "huy");
    expect(after.id).toBe(before.id);
    expect(after.emailNormalized).toBe("huy.moi@example.com");
    expect(after.issues).toContain("email_changed_from_suppressed");
    expect(await ctx.db.select().from(suppressions).where(eq(suppressions.emailNormalized, "huy.bui@example.com"))).toHaveLength(1);
    expect(await ctx.db.select().from(suppressions).where(eq(suppressions.emailNormalized, "huy.moi@example.com"))).toHaveLength(0);
    expect((await currentConsent(ctx.db, "huy.moi@example.com")).marketing_email).toBe("unknown");
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, "crm.email_changed_from_suppressed"))).toHaveLength(1);
  });

  it("R-SYNC-04: trashed pages are archived (when returned), removed pages are archived by a full sync only, restored pages reactivate", async () => {
    ctx = await setupCrm({ pages: "synthetic", fake: { queryIncludesTrashed: true } });
    await full(ctx);
    expect(await byPage(ctx, "trashed")).toMatchObject({ state: "archived", archivedReason: "notion_trashed" });

    ctx.fake.removePage(ctx.pageIds.ngoc);
    const inc = await incr(ctx);
    expect(inc.counts.archivedMissing).toBe(0);
    expect((await byPage(ctx, "ngoc")).state).toBe("active"); // incremental never archives missing pages
    const f = await full(ctx);
    expect(f.counts.archivedMissing).toBe(1);
    expect(await byPage(ctx, "ngoc")).toMatchObject({ state: "archived", archivedReason: "missing_from_source" });

    ctx.time.advance(120_000);
    ctx.fake.editPage(ctx.pageIds.trashed, {}, { inTrash: false });
    const r = await incr(ctx);
    expect(r.counts.reactivated).toBe(1);
    expect((await byPage(ctx, "trashed")).state).toBe("active");
  });

  it("archived duplicates no longer count as duplicates", async () => {
    ctx = await setupCrm({ pages: "synthetic", fake: { queryIncludesTrashed: true } });
    await full(ctx);
    ctx.time.advance(120_000);
    ctx.fake.editPage(ctx.pageIds["mai-2"], {}, { inTrash: true });
    await incr(ctx);
    expect((await byPage(ctx, "mai-1")).isDuplicate).toBe(false);
  });
});

describe("R-SYNC-05: suppression and consent are never weakened by sync", () => {
  it("Notion 'Subscribed' after an unsubscribe keeps the suppression, queues a Notion correction and is echo-free", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    await full(ctx);
    ctx.time.advance(120_000);
    ctx.fake.editPage(ctx.pageIds.huy, { "Subscription status": { type: "select", select: { name: "Subscribed" } } });
    const r = await incr(ctx);
    expect(r.counts.outboxQueued).toBe(1);
    expect(await ctx.db.select().from(suppressions).where(eq(suppressions.emailNormalized, "huy.bui@example.com"))).toHaveLength(1);
    expect((await currentConsent(ctx.db, "huy.bui@example.com")).marketing_email).toBe("withdrawn");
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, "crm.resubscribe_ignored"))).toHaveLength(1);

    const flushed = await flushOutbox(ctx.db, ctx.env);
    expect(flushed).toMatchObject({ claimed: 1, done: 1 });
    const page = ctx.fake.pages.get(ctx.pageIds.huy)!;
    expect((page.properties["Subscription status"] as { select: { name: string } }).select.name).toBe("Unsubscribed");

    ctx.time.advance(60_000);
    const r2 = await incr(ctx);
    expect(r2.counts.outboxQueued).toBe(0); // our own write does not trigger another correction
  });

  it("blank subscription in Notion never removes a suppression either", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    await full(ctx);
    ctx.time.advance(120_000);
    ctx.fake.editPage(ctx.pageIds.tram, { "Subscription status": { type: "select", select: null } });
    await incr(ctx);
    expect(await ctx.db.select().from(suppressions).where(eq(suppressions.emailNormalized, "tram.ho@example.org"))).toHaveLength(1);
    const ob = await ctx.db.select().from(notionOutbox);
    expect(ob[0].payload).toEqual({ label: "Unsubscribed" });
  });

  it("the database refuses to delete/alter suppressions or consent, and refuses imported grants", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    await full(ctx);
    const p = ctx.db.$client;
    await expect(p.query("delete from suppressions")).rejects.toThrow(/append-only/);
    await expect(p.query("update suppressions set reason = 'manual'")).rejects.toThrow(/append-only/);
    await expect(p.query("update consent_records set status = 'granted'")).rejects.toThrow(/append-only/);
    await expect(
      p.query("insert into consent_records (email_normalized, purpose, status, source, recorded_by, evidence_ref) values ('x@example.com','marketing_email','granted','notion_import','t','ref')"),
    ).rejects.toThrow(/consent_import_never_grants/);
    await expect(
      p.query("insert into consent_records (email_normalized, purpose, status, source, recorded_by) values ('x@example.com','marketing_email','granted','staff_entry','t')"),
    ).rejects.toThrow(/consent_grant_requires_evidence/);
  });
});

describe("R-SYNC-06 and partial failures", () => {
  it("recovers from 429 (Retry-After) and 503 during listing", async () => {
    ctx = await setupCrm();
    addGeneratedPages(ctx, 150);
    ctx.fake.faults.push({ method: "POST", pathIncludes: "/query", status: 429, retryAfterSeconds: 2, times: 2 });
    ctx.fake.faults.push({ method: "POST", pathIncludes: "/query", status: 503, skip: 0, times: 1 });
    const r = await full(ctx);
    expect(r.status).toBe("succeeded");
    expect(r.counts.fetched).toBe(150);
    expect(ctx.time.sleeps.filter((s) => s === 2000).length).toBeGreaterThanOrEqual(2);
  });

  it("when retries are exhausted mid-listing: partial, cursor unchanged, nothing archived; the next run completes without duplicates", async () => {
    ctx = await setupCrm();
    addGeneratedPages(ctx, 250);
    await full(ctx);
    const cursor1 = (await ctx.db.select().from(syncState))[0].incrementalCursor;
    ctx.fake.faults.push({ method: "POST", pathIncludes: "/query", status: 503, skip: 1, times: 50 });
    const r = await full(ctx);
    expect(r).toMatchObject({ status: "partial", errorCode: "service_unavailable" });
    expect(r.counts.fetched).toBe(100);
    expect(r.counts.archivedMissing).toBe(0);
    expect((await ctx.db.select().from(syncState))[0].incrementalCursor).toEqual(cursor1);
    expect(await ctx.db.select().from(contacts).where(eq(contacts.state, "archived"))).toHaveLength(0);
    ctx.fake.faults = [];
    const again = await full(ctx);
    expect(again.status).toBe("succeeded");
    expect(await count(ctx, "contacts")).toBe(250);
  });

  it("isolates a failing page: others are imported, the run is partial and the page is retried next time", async () => {
    ctx = await setupCrm();
    const ids = addGeneratedPages(ctx, 10);
    const r = await full(ctx, {
      beforePageWrite: (p) => {
        if (p.id === ids[3]) throw new Error("simulated database error for one page");
      },
    });
    expect(r).toMatchObject({ status: "partial", errorCode: "page_errors" });
    expect(r.counts).toMatchObject({ fetched: 10, created: 9, pageErrors: 1 });
    expect(r.cursorAfter).toEqual(r.cursorBefore); // cursor not advanced
    const iss = await ctx.db.select().from(syncIssues).where(eq(syncIssues.runId, r.runId!));
    expect(iss).toMatchObject([{ severity: "error", code: "page_processing_failed", notionPageId: ids[3] }]);
    const r2 = await incr(ctx);
    expect(r2.status).toBe("succeeded");
    expect(await count(ctx, "contacts")).toBe(10);
  });

  it("records data problems (unexpected property type) without failing the run", async () => {
    ctx = await setupCrm();
    const [id] = addGeneratedPages(ctx, 1);
    // A type no mapped field accepts (rich_text would be a valid alternative for Email).
    ctx.fake.pages.get(id)!.properties.Email = { type: "number", number: 42 } as never;
    const r = await full(ctx);
    expect(r.status).toBe("succeeded");
    expect(r.counts.dataIssues).toBe(1);
    expect((await ctx.db.select().from(contacts))[0]).toMatchObject({ emailStatus: "missing" });
  });

  it("fails safely on schema drift (mapped property renamed) without touching contacts", async () => {
    ctx = await setupCrm({ pages: "synthetic" });
    await full(ctx);
    const snapshot = await ctx.db.select().from(contacts);
    ctx.fake.renameProperty(ctx.dataSourceId, "Email", "E-mail address");
    const r = await full(ctx);
    expect(r).toMatchObject({ status: "failed", errorCode: "schema_mismatch" });
    expect(r.errorMessage).toMatch(/"Email" does not exist/);
    expect(await ctx.db.select().from(contacts)).toEqual(snapshot);
    expect((await ctx.db.select().from(notionConnection))[0].lastError).toMatch(/Mapping no longer matches/);
  });

  it("allows only one sync at a time and marks interrupted runs", async () => {
    ctx = await setupCrm();
    addGeneratedPages(ctx, 5);
    await ctx.db.insert(syncRuns).values({ mode: "full", trigger: "test", status: "running", requestedBy: "crashed-worker" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = full(ctx, {
      beforePageWrite: async () => {
        entered();
        await gate;
      },
    });
    await inside;
    const second = await full(ctx);
    expect(second).toMatchObject({ status: "skipped", errorCode: "already_running" });
    release();
    expect((await first).status).toBe("succeeded");
    const crashed = (await ctx.db.select().from(syncRuns).where(eq(syncRuns.requestedBy, "crashed-worker")))[0];
    expect(crashed).toMatchObject({ status: "failed", errorCode: "interrupted" });
  });
});

describe("connection and token handling", () => {
  it("stores the token encrypted only, and a wrong token is rejected without storing anything", async () => {
    ctx = await setupCrm();
    const row = (await ctx.db.select().from(notionConnection))[0];
    expect(row.tokenCiphertext).not.toContain(ctx.fake.token);
    expect(row.tokenHint).toBe(ctx.fake.token.slice(-4));
    const dump = JSON.stringify(await ctx.db.select().from(auditLog));
    expect(dump).not.toContain(ctx.fake.token);

    const bad = await connectExistingDatabase(ctx.db, ctx.env, { token: "ntn_wrong", databaseIdOrUrl: ctx.databaseId, actor: "test" });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/401/) });
    expect((await ctx.db.select().from(notionConnection))[0].tokenCiphertext).toBe(row.tokenCiphertext);
  });

  it("creates the CRM database under a parent page and syncs from it", async () => {
    ctx = await setupCrm();
    ctx.fake.parentPages.add("44444444-4444-4444-8444-444444444444");
    const r = await createCrmDatabase(ctx.db, ctx.env, { token: ctx.fake.token, parentPageIdOrUrl: "https://www.notion.so/acme/CRM-44444444444444448444444444444444", actor: "test" });
    expect(r).toMatchObject({ ok: true, validation: { ok: true } });
    const conn = (await ctx.db.select().from(notionConnection))[0];
    ctx.fake.addPage(conn.dataSourceId!, crmPageProperties({ name: "Người mới", greeting: "Bạn", email: "nguoi.moi@example.com" }));
    expect((await full(ctx)).counts.created).toBe(1);
  });
});

describe("Notion outbox", () => {
  async function suppressedCtx() {
    const c = await setupCrm({ pages: "synthetic" });
    await full(c);
    c.time.advance(120_000);
    c.fake.editPage(c.pageIds.huy, { "Subscription status": { type: "select", select: { name: "Subscribed" } } });
    await incr(c);
    return c;
  }

  it("retries a 503 later with backoff and marks 404 as permanently failed", async () => {
    ctx = await suppressedCtx();
    ctx.fake.faults.push({ method: "PATCH", status: 503, times: 20 });
    const r1 = await flushOutbox(ctx.db, ctx.env);
    expect(r1).toMatchObject({ claimed: 1, retrying: 1 });
    const row = (await ctx.db.select().from(notionOutbox))[0];
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await flushOutbox(ctx.db, ctx.env)).toMatchObject({ claimed: 0 }); // not due yet
    ctx.fake.faults = [];
    ctx.fake.removePage(ctx.pageIds.huy);
    const later = () => new Date(Date.now() + 2 * 3_600_000);
    expect(await flushOutbox(ctx.db, ctx.env, { now: later })).toMatchObject({ failed: 1 });
    expect((await ctx.db.select().from(notionOutbox))[0]).toMatchObject({ status: "failed" });
  });

  it("coalesces writes and never marks a newer value done by mistake", async () => {
    ctx = await suppressedCtx();
    const { enqueueSubscriptionWrite } = await import("../../src/lib/crm/outbox");
    await enqueueSubscriptionWrite(ctx.db, { notionPageId: ctx.pageIds.huy, label: "Bounced", reason: "test" });
    expect(await ctx.db.select().from(notionOutbox).where(eq(notionOutbox.status, "pending"))).toHaveLength(1);
    // While the PATCH is in flight, a newer value is enqueued.
    const original = ctx.fake.fetch;
    let injected = false;
    ctx.env.fetch = async (input, init) => {
      if (!injected && init?.method === "PATCH") {
        injected = true;
        await enqueueSubscriptionWrite(ctx!.db, { notionPageId: ctx!.pageIds.huy, label: "Complained", reason: "newer" });
      }
      return original(input, init);
    };
    await flushOutbox(ctx.db, ctx.env);
    const pending = await ctx.db.select().from(notionOutbox).where(and(eq(notionOutbox.status, "pending"), eq(notionOutbox.notionPageId, ctx.pageIds.huy)));
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toEqual({ label: "Complained" });
  });
});
