/**
 * M4 integration tests: test sends and the personalization check against REAL PostgreSQL with a
 * MOCK transport (scripted outcomes) — MOCK: proves our logic, not the live SES service.
 * IDs refer to docs/PLAN.md "M4 regression additions".
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/lib/clock";
import { closeDb, getDb, type Db } from "../../src/lib/db/client";
import { auditLog, contacts, suppressions, testSends } from "../../src/lib/db/schema";
import { reapStaleTestSends, sendTestEmail, TestSendError, type TestSendConfig, type TestSendDeps } from "../../src/lib/sending/test-send";
import { MockTransport, type OutboundMessage, type SendResult } from "../../src/lib/sending/transport";
import { personalizationCheck } from "../../src/lib/templates/recipients";
import { importTemplate, saveSubject } from "../../src/lib/templates/service";
import { createTestDatabase } from "./helpers";

const ALLOWED = "qa-inbox@example.com";
const cfg = (over: Partial<TestSendConfig> = {}): TestSendConfig => ({
  APP_ENV: "test",
  SEND_MODE: "mock",
  TEST_RECIPIENT_ALLOWLIST: [ALLOWED, "qa-2@example.org"],
  SEND_AUTHORIZATION_REF: undefined,
  SES_REGION: "ap-southeast-1",
  SES_FROM_ADDRESS: undefined,
  SES_CONFIGURATION_SET: undefined,
  SES_TIMEOUT_MS: 1000,
  TEST_SEND_MAX_PER_HOUR: 10,
  TEST_SEND_MAX_PER_DAY: 50,
  ...over,
});

const HTML = `<!DOCTYPE html><html><head><title>Bản tin</title></head><body><p>Chào {{ greeting_name | default: "bạn" }},</p><p>{{ company | default: "Quý công ty" }}</p><a href="{{ unsubscribe_url }}">Hủy đăng ký</a></body></html>`;

let db: Db;
let drop: () => Promise<void>;
let templateId: string;
let versionId: string;

beforeAll(async () => {
  const t = await createTestDatabase("m4_test_send");
  drop = t.drop;
  db = getDb(t.url);
});
afterAll(async () => {
  await closeDb();
  await drop();
});

beforeEach(async () => {
  // suppressions and contacts are append-only/guarded; only test_sends is reset between tests.
  await db.execute(sql`truncate test_sends`);
  const r = await importTemplate(db, { name: "Bản tin", html: HTML, sourceKind: "paste", sourceFilename: null, extractSelector: null, actor: "test" });
  const v = await saveSubject(db, { templateId: r.template.id, baseVersionId: r.version.id, subject: 'Chào {{ greeting_name | default: "bạn" }} — ưu đãi tháng 11', actor: "test" });
  templateId = r.template.id;
  versionId = v.id;
});

const input = (over: Partial<Parameters<typeof sendTestEmail>[2]> = {}) => ({
  templateId,
  versionId,
  recipients: ALLOWED,
  mergeSource: "sample-no-greeting",
  idempotencyKey: randomUUID(),
  actor: "user:tester",
  correlationId: "req-test",
  ...over,
});

function scripted(fn: (m: OutboundMessage) => SendResult | Promise<SendResult>) {
  const calls: OutboundMessage[] = [];
  const mock = new MockTransport(async (m) => {
    calls.push(m);
    return fn(m);
  });
  return { mock, calls };
}
const deps = (mock: MockTransport, over: Partial<TestSendConfig> = {}, clock?: FixedClock): TestSendDeps => ({ cfg: cfg(over), mock, clock });

describe("test sends (MOCK transport, real PostgreSQL)", () => {
  it("OR-TS-01 / R-TS-07: renders with fallbacks, prefixes [TEST], tags the message and records accepted", async () => {
    const s = scripted((m) => ({ kind: "accepted", providerMessageId: `mock-${m.messageId}` }));
    const out = await sendTestEmail(db, deps(s.mock), input());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "accepted", recipient: "q***@example.com" });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].subject).toBe("[TEST] Chào bạn — ưu đãi tháng 11");
    expect(s.calls[0].html).toContain("<p>Chào bạn,</p>");
    expect(s.calls[0].html).toContain("<p>Phúc Lợi JSC</p>");
    expect(s.calls[0].text).toContain("Chào bạn");
    expect(s.calls[0].tags).toMatchObject({ purpose: "test_send" });
    const [row] = await db.select().from(testSends);
    expect(row).toMatchObject({ status: "accepted", recipientEmail: ALLOWED, providerMessageId: `mock-${row.id}`, sendMode: "mock" });
    expect(s.calls[0].messageId).toBe(row.id);
  });

  it("R-TS-02: an address that is not allowlisted is refused by the server, without revealing the list", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    const out = await sendTestEmail(db, deps(s.mock), input({ recipients: `stranger@example.net, ${ALLOWED}` }));
    expect(out.map((o) => o.status)).toEqual(["refused", "accepted"]);
    expect(out[0].message).toMatch(/not on the list of permitted test recipients/);
    expect(out[0].message).not.toContain(ALLOWED);
    expect(s.calls.map((c) => c.to)).toEqual([ALLOWED]);
  });

  it("R-TS-03: a suppressed address is refused even when it is allowlisted", async () => {
    await db.insert(suppressions).values({ emailNormalized: "qa-2@example.org", reason: "unsubscribe", source: "test", createdBy: "test" });
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    const out = await sendTestEmail(db, deps(s.mock), input({ recipients: "qa-2@example.org" }));
    expect(out[0]).toMatchObject({ status: "refused" });
    expect(out[0].message).toMatch(/suppressed/);
    expect(s.calls).toHaveLength(0);
  });

  it("R-TS-04: a double submit with the same key calls the provider once", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "once" }));
    const i = input();
    const [a, b] = await Promise.all([sendTestEmail(db, deps(s.mock), i), sendTestEmail(db, deps(s.mock), i)]);
    expect(s.calls).toHaveLength(1);
    expect([a[0].duplicate, b[0].duplicate].filter(Boolean)).toHaveLength(1);
    expect((await db.select().from(testSends)).length).toBe(1);
  });

  it("R-TS-05: an uncertain outcome is stored as unknown, never retried; 'send again' is a new linked row", async () => {
    const s = scripted(() => ({ kind: "unknown", message: "no response from SES within 1000 ms" }));
    const first = await sendTestEmail(db, deps(s.mock), input());
    expect(first[0].status).toBe("unknown");
    expect(s.calls).toHaveLength(1);
    // Nothing moves it back: the DB refuses unknown → claimed.
    const blocked = await db.update(testSends).set({ status: "claimed" }).where(eq(testSends.id, first[0].id)).catch((e: Error & { cause?: Error }) => e);
    expect(String((blocked as Error & { cause?: Error }).cause?.message ?? blocked)).toMatch(/illegal test_sends status change unknown -> claimed/);
    const again = await sendTestEmail(db, deps(s.mock), input({ resendOf: first[0].id }));
    expect(s.calls).toHaveLength(2);
    const rows = await db.select().from(testSends);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === again[0].id)?.resendOf).toBe(first[0].id);
  });

  it("an unexpected throw during the provider call is recorded as unknown", async () => {
    const s = scripted(() => {
      throw new Error("socket hang up");
    });
    const out = await sendTestEmail(db, deps(s.mock), input());
    expect(out[0].status).toBe("unknown");
  });

  it("R-TS-08: per-person hourly limit (refusals do not count)", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    await sendTestEmail(db, deps(s.mock, { TEST_SEND_MAX_PER_HOUR: 2 }), input({ recipients: `${ALLOWED}, nope@example.net` }));
    await sendTestEmail(db, deps(s.mock, { TEST_SEND_MAX_PER_HOUR: 2 }), input());
    await expect(sendTestEmail(db, deps(s.mock, { TEST_SEND_MAX_PER_HOUR: 2 }), input())).rejects.toThrow(/at most 2 test emails per person per hour/);
    expect(s.calls).toHaveLength(2);
  });

  it("R-TS-09: test-send rows have no campaign link", async () => {
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'test_sends'`);
    expect((cols.rows as Array<{ column_name: string }>).map((c) => c.column_name)).not.toContain("campaign_id");
  });

  it("R-TS-10: the reaper turns a stale claim into unknown and nothing is re-sent", async () => {
    const clock = new FixedClock(new Date());
    // Simulate a crash between claim and result.
    await db.insert(testSends).values({ idempotencyKey: randomUUID(), templateId, templateVersionId: versionId, requestedBy: "user:t", recipientEmail: ALLOWED, mergeSource: "sample-full", status: "claimed", sendMode: "mock", claimedAt: clock.now() });
    expect(await reapStaleTestSends(db, clock)).toBe(0); // not stale yet
    clock.advance(11 * 60 * 1000);
    expect(await reapStaleTestSends(db, clock)).toBe(1);
    const [row] = await db.select().from(testSends);
    expect(row).toMatchObject({ status: "unknown", errorCode: "stale_claim" });
    expect(await reapStaleTestSends(db, clock)).toBe(0);
  });

  it("R-TS-11: audit rows contain only the masked address", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    const correlationId = `req-${randomUUID()}`;
    await sendTestEmail(db, deps(s.mock), input({ recipients: `${ALLOWED}, stranger@example.net`, correlationId }));
    const rows = await db.select().from(auditLog).where(eq(auditLog.correlationId, correlationId));
    expect(rows.map((r) => r.action).sort()).toEqual(["test_send.accepted", "test_send.refused"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(ALLOWED);
    expect(text).not.toContain("stranger@example.net");
    expect(text).toContain("q***@example.com");
  });

  it("R-TS-12: SEND_MODE=disabled refuses on the server", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    const out = await sendTestEmail(db, deps(s.mock, { SEND_MODE: "disabled" }), input());
    expect(out[0]).toMatchObject({ status: "refused" });
    expect(out[0].message).toMatch(/sending is disabled/);
    expect(s.calls).toHaveLength(0);
  });

  it("allowlist mode without SES configured: claimed then rejected (transport unavailable), never sent", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    const out = await sendTestEmail(db, deps(s.mock, { SEND_MODE: "allowlist", SEND_AUTHORIZATION_REF: "test-ref" }), input());
    expect(out[0].status).toBe("rejected");
    expect(out[0].message).toMatch(/No real email transport is configured/);
    expect(s.calls).toHaveLength(0);
  });

  it("R-PERS-03: a missing value without fallback blocks the send before any row is written", async () => {
    const v = await saveSubject(db, { templateId, baseVersionId: versionId, subject: "Chào {{ greeting_name }}", actor: "test" });
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    const e = await sendTestEmail(db, deps(s.mock), input({ versionId: v.id })).catch((x) => x);
    expect(e).toBeInstanceOf(TestSendError);
    expect(e.details.join()).toMatch(/greeting_name: no value/);
    expect((await db.select().from(testSends)).length).toBe(0);
  });

  it("validates input: bad addresses, more than three, unknown merge source", async () => {
    const s = scripted(() => ({ kind: "accepted", providerMessageId: "x" }));
    await expect(sendTestEmail(db, deps(s.mock), input({ recipients: "not-an-email" }))).rejects.toThrow(/Not a valid email address/);
    await expect(sendTestEmail(db, deps(s.mock), input({ recipients: "a@example.com,b@example.com,c@example.com,d@example.com" }))).rejects.toThrow(/At most 3/);
    await expect(sendTestEmail(db, deps(s.mock), input({ mergeSource: "contact:00000000-0000-4000-8000-000000000000" }))).rejects.toThrow(/Choose whose data/);
  });
});

describe("personalization check (real PostgreSQL)", () => {
  it("R-PERS-05: lists exactly the active, valid contacts missing a value that has no fallback", async () => {
    await db.insert(contacts).values([
      { notionPageId: "p1", fullName: "Có Tên Gọi", greetingName: "Chị Lan", email: "lan@example.com", emailNormalized: "lan@example.com", emailStatus: "valid", company: "A" },
      { notionPageId: "p2", fullName: "Thiếu Tên Gọi", greetingName: null, email: "b@example.com", emailNormalized: "b@example.com", emailStatus: "valid", company: "B" },
      { notionPageId: "p3", fullName: "Email Sai", greetingName: null, email: "bad", emailNormalized: "bad", emailStatus: "invalid" },
      { notionPageId: "p4", fullName: "Đã Lưu Trữ", greetingName: null, email: "c@example.com", emailNormalized: "c@example.com", emailStatus: "valid", state: "archived" },
    ]);
    const withFallback = await personalizationCheck(db, { subject: 'Chào {{ greeting_name | default: "bạn" }}', html: HTML });
    expect(withFallback).toMatchObject({ checked: 2, affected: [], blocking: [], fieldsNeedingValues: [] });
    const without = await personalizationCheck(db, { subject: "Chào {{ greeting_name }}", html: "<p>{{ company }} {{ first_name }}</p>" });
    expect(without.checked).toBe(2);
    expect(without.fieldsNeedingValues).toEqual(["company", "greeting_name"]);
    expect(without.affected).toEqual([{ id: expect.any(String), name: "Thiếu Tên Gọi", missing: ["greeting_name"] }]);
    expect(without.blocking.map((b) => b.error)).toEqual(["unknown field"]);
    const noSubject = await personalizationCheck(db, { subject: null, html: HTML });
    expect(noSubject.blocking[0].error).toMatch(/no subject/);
  });
});
