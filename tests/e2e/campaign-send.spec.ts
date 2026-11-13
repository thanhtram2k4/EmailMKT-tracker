/**
 * M5 campaigns through the UI (Chromium, local stack, synthetic data). MOCK only: the stack refuses
 * real send modes, so nothing leaves the machine.
 *  - `npm run e2e`                 → SEND_MODE=disabled: review blocks, the Send button is off;
 *  - `npm run e2e:mock-campaign`   → SEND_MODE=mock: OR-CMP-01 end to end (create → review → send now
 *    → completed), OR-CMP-02 unsubscribe (GET confirms only, POST/one-click suppresses), OR-CMP-03 a
 *    signed SES event over HTTP (stack test key; no AWS), and the member view.
 * Contacts are inserted directly into the stack's throwaway database (reserved example.com addresses).
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { sign } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { stringToSign, type SnsMessage } from "../../src/lib/campaigns/sns";

const MODE = process.env.SEND_MODE ?? "disabled";
const SHOTS = process.env.CAMPAIGN_SHOTS ?? "test-results/campaign-send/screenshots";
mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);
const TAG = `e2e-m5-${RUN}`;
const email = (i: number) => `${TAG}-${i}@example.com`;

const HTML = `<!DOCTYPE html><html><head><title>M5 campaign fixture (SYNTHETIC)</title></head><body>
<table role="presentation" width="100%"><tr><td>
<h1>Ưu đãi tháng 11</h1>
<p>Chào {{ greeting_name | default: "Quý khách" }},</p>
<p><a href="https://shop.example.com/offer">Xem ưu đãi</a></p>
<p style="font-size:12px;color:#64748b">Bạn nhận email này vì đã đăng ký. <a href="{{ unsubscribe_url }}">Hủy đăng ký</a></p>
</td></tr></table></body></html>`;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** 5 synthetic contacts: 3 eligible, 1 without consent, 1 suppressed. */
async function seedContacts() {
  const people = [
    ["Nguyễn Văn An", "Anh An", true, false],
    ["Trần Thị Bình", null, true, false],
    ["Lê Văn Cường", "Anh Cường", true, false],
    ["Phạm Dũng", "Anh Dũng", false, false],
    ["Hoàng Em", "Chị Em", true, true],
  ] as const;
  for (const [i, [name, greet, consent, suppressed]] of people.entries()) {
    await q(
      `insert into contacts (notion_page_id, full_name, greeting_name, email, email_normalized, email_status, company, tags)
       values ($1, $2, $3, $4, $4, 'valid', 'Công ty Ví dụ', $5)`,
      [`e2e-${TAG}-${i}`, name, greet, email(i), [TAG]],
    );
    if (consent) {
      await q(`insert into consent_records (email_normalized, purpose, status, source, recorded_by, evidence_ref) values ($1, 'marketing_email', 'granted', 'staff_entry', 'e2e', 'E2E-FORM')`, [email(i)]);
    }
    if (suppressed) {
      // The default (disabled) stack is shared with crm.spec, which asserts the suppression count, so
      // there this contact is excluded by withdrawn consent instead (found in the M5 run 1 failure).
      if (MODE === "mock") await q(`insert into suppressions (email_normalized, reason, source, created_by, note) values ($1, 'manual', 'e2e', 'e2e', 'synthetic')`, [email(i)]);
      else await q(`insert into consent_records (email_normalized, purpose, status, source, recorded_by, evidence_note) values ($1, 'marketing_email', 'withdrawn', 'staff_entry', 'e2e', 'synthetic')`, [email(i)]);
    }
  }
}

async function signIn(page: Page, who = "admin@example.com") {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(who);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(who);
}

async function importEmail(page: Page, name: string) {
  await page.goto("/templates");
  await page.getByTestId("import-html").fill(HTML);
  await page.getByTestId("import-name").fill(name);
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  await page.getByTestId("subject-input").fill('[QC] Ưu đãi cho {{ greeting_name | default: "bạn" }}');
  await page.getByTestId("subject-save").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
}

async function createDraft(page: Page, emailName: string, campaignName: string) {
  await page.goto("/campaigns");
  await page.getByTestId("campaign-name").fill(campaignName);
  await page.getByTestId("campaign-template").selectOption({ label: `${emailName} (v2)` });
  await page.getByTestId("audience-tags").check();
  await page.getByRole("checkbox", { name: TAG }).check();
  await page.getByTestId("campaign-create").click();
  await expect(page.getByTestId("campaign-title")).toHaveText(campaignName);
  await expect(page.getByTestId("campaign-status")).toHaveText("draft");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedContacts();
});

test("disabled mode: review blocks and Send now is off", async ({ page }) => {
  test.skip(MODE !== "disabled", "runs in the default (SEND_MODE=disabled) stack");
  await signIn(page);
  const name = `M5 disabled ${RUN}`;
  await importEmail(page, name);
  await createDraft(page, name, `Disabled ${RUN}`);
  await expect(page.getByTestId("review-included")).toHaveText("3");
  await expect(page.getByTestId("review-exclusions")).toContainText("Consent withdrawn");
  await expect(page.getByTestId("review-blocking")).toContainText("sending is disabled");
  await expect(page.getByTestId("send-now")).toBeDisabled();
  await page.screenshot({ path: path.join(SHOTS, "disabled-review.png"), fullPage: true });
});

test.describe("mock sending", () => {
  test.skip(MODE !== "mock", "needs the SEND_MODE=mock stack (npm run e2e:mock-campaign)");
  let campaignUrl = "";
  let campaignId = "";

  test("OR-CMP-01: create → review (exclusions) → send now → completed; each recipient sent once", async ({ page }) => {
    await signIn(page);
    const name = `M5 email ${RUN}`;
    await importEmail(page, name);
    await createDraft(page, name, `Ưu đãi ${RUN}`);
    campaignUrl = page.url().split("?")[0];
    campaignId = campaignUrl.split("/").pop()!;

    await expect(page.getByTestId("review-included")).toHaveText("3");
    await expect(page.getByTestId("review-excluded")).toHaveText("2");
    await expect(page.getByTestId("review-exclusions")).toContainText("No recorded marketing consent");
    await expect(page.getByTestId("review-exclusions")).toContainText("Suppressed");
    await expect(page.getByTestId("review-sample-subject")).toContainText("[QC] Ưu đãi cho");
    await expect(page.getByTestId("review-blocking")).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "01-review.png"), fullPage: true });

    await page.getByTestId("send-now-confirm").check();
    await page.getByTestId("send-now").click();
    await expect(page.getByTestId("flash-ok")).toContainText("3 message(s) queued");
    await expect(page.getByTestId("campaign-status")).toHaveText("completed", { timeout: 60_000 });
    await expect(page.getByTestId("kpi-sent")).toContainText("3");
    await expect(page.getByTestId("kpi-unknown")).toContainText("0");
    await expect(page.getByTestId("recipients-table")).toContainText(email(1));
    await expect(page.getByTestId("recipients-table")).not.toContainText(email(3));
    await page.screenshot({ path: path.join(SHOTS, "02-completed.png"), fullPage: true });

    // Cross-check with the mock transport's call log: exactly one provider call per message.
    const ids = (await q<{ id: string }>(`select id from messages where campaign_id = $1`, [campaignId])).map((r) => r.id);
    const logFile = path.join(process.env.STACK_LOG_DIR ?? ".", "mock-transport-calls.jsonl");
    expect(existsSync(logFile)).toBe(true);
    const calls = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { messageId: string });
    const mine = calls.filter((c) => ids.includes(c.messageId)).map((c) => c.messageId);
    expect(mine.sort()).toEqual([...ids].sort());
  });

  test("OR-CMP-02: unsubscribe — GET only confirms, the button and one-click POST suppress", async ({ page, request }) => {
    const rows = await q<{ email_normalized: string; tracking_token: string }>(`select email_normalized, tracking_token from messages where campaign_id = $1 order by email_normalized`, [campaignId]);
    const t0 = rows.find((r) => r.email_normalized === email(0))!.tracking_token;
    const t1 = rows.find((r) => r.email_normalized === email(1))!.tracking_token;
    const suppressed = async (e: string) => (await q(`select 1 from suppressions where email_normalized = $1`, [e])).length > 0;

    await page.goto(`/u/${t0}`); // public: no sign-in
    await expect(page.getByTestId("unsub-confirm")).toBeVisible();
    await expect(page.locator("body")).toContainText("e***@example.com");
    expect(await suppressed(email(0))).toBe(false); // a GET (e.g. a link scanner) changes nothing
    await page.screenshot({ path: path.join(SHOTS, "03-unsubscribe-confirm.png"), fullPage: true });
    await page.getByTestId("unsub-submit").click();
    await expect(page.getByTestId("unsub-done")).toBeVisible();
    expect(await suppressed(email(0))).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, "04-unsubscribe-done.png"), fullPage: true });

    const r = await request.post(`/u/${t1}`, { form: { "List-Unsubscribe": "One-Click" } });
    expect(r.status()).toBe(200);
    expect(await r.text()).toBe("unsubscribed");
    expect(await suppressed(email(1))).toBe(true);
    expect((await q<{ status: string; source: string }>(`select status::text as status, source::text as source from consent_records where email_normalized = $1 order by id desc limit 1`, [email(1)]))[0]).toEqual({
      status: "withdrawn",
      source: "unsubscribe_link",
    });
    expect((await request.get(`/u/${"A".repeat(22)}`)).status()).toBe(404);

    await signIn(page);
    await page.goto(`/suppressions?q=${TAG}`);
    await expect(page.getByTestId("suppressions-table")).toContainText(email(0));
    await expect(page.getByTestId("suppressions-table")).toContainText(email(1));
    await page.screenshot({ path: path.join(SHOTS, "05-suppressions.png"), fullPage: true });
  });

  test("OR-CMP-03: a signed SES Delivery event over HTTP updates the campaign; a bad signature is refused", async ({ page, request }) => {
    const keyFile = process.env.SNS_TEST_PRIVATE_KEY_FILE;
    expect(keyFile, "local stack provides a test signing key").toBeTruthy();
    const key = readFileSync(keyFile!, "utf8");
    const m2 = (await q<{ id: string }>(`select id from messages where campaign_id = $1 and email_normalized = $2`, [campaignId, email(2)]))[0];
    const msg: SnsMessage = {
      Type: "Notification",
      MessageId: `e2e-${RUN}-delivery`,
      TopicArn: "arn:aws:sns:ap-southeast-1:123456789012:emt-local-stack-events",
      Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "0100-e2e", timestamp: new Date().toISOString(), tags: { msg_id: [m2.id], purpose: ["campaign"], attempt: ["1"] } }, delivery: { timestamp: new Date().toISOString() } }),
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: "https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-test.pem",
    };
    msg.Signature = sign("sha256", Buffer.from(stringToSign(msg)), key).toString("base64");
    const ok = await request.post("/api/ses-events", { data: JSON.stringify(msg), headers: { "content-type": "text/plain; charset=UTF-8", "x-amz-sns-message-type": "Notification" } });
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toBe("processed");
    const bad = await request.post("/api/ses-events", { data: JSON.stringify({ ...msg, MessageId: `e2e-${RUN}-bad`, Signature: msg.Signature.slice(4) + "AAAA" }), headers: { "content-type": "text/plain" } });
    expect(bad.status()).toBe(403);

    await signIn(page);
    await page.goto(campaignUrl);
    await expect(page.getByTestId("kpi-delivered")).toContainText("1");
    await page.screenshot({ path: path.join(SHOTS, "06-delivered.png"), fullPage: true });
  });

  test("member: can create and review a draft but cannot send it", async ({ page }) => {
    await signIn(page, "member@example.com");
    const name = `M5 member ${RUN}`;
    await importEmail(page, name);
    await createDraft(page, name, `Member draft ${RUN}`);
    await expect(page.getByTestId("send-now")).toHaveCount(0);
    await expect(page.getByTestId("send-now-card")).toContainText("An administrator reviews and sends campaigns");
    await page.screenshot({ path: path.join(SHOTS, "07-member-draft.png"), fullPage: true });
  });
});
