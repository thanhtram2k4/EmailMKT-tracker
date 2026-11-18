/**
 * M7 tracking and analytics through HTTP and the UI (Chromium, local stack, synthetic data). MOCK only.
 *  - `npm run e2e`               → disabled stack: the public endpoints answer 404 for unknown tokens
 *                                  without a sign-in redirect;
 *  - `npm run e2e:mock-campaign` → OR-TRK-01: send to 2 tracked recipients; open pixel; 3 clicks on one
 *                                  link (1 unique / 3 recorded); redirect only to the snapshot URL;
 *                                  tampered token/index → 404; HEAD and scanner clicks flagged; recorded
 *                                  vs filtered shown; recipient timeline. OR-ROLE-01: a member cannot
 *                                  schedule or send.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const MODE = process.env.SEND_MODE ?? "disabled";
const SHOTS = process.env.CAMPAIGN_SHOTS ?? "test-results/campaign-tracking/screenshots";
mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);
const TAG = `e2e-m7-${RUN}`;
const HTML = `<!DOCTYPE html><html><head><title>M7 tracking fixture (SYNTHETIC)</title></head><body>
<p>Chào {{ greeting_name | default: "Quý khách" }}</p>
<p><a href="https://shop.example.com/sale?utm=m7">Xem ưu đãi</a> · <a href="https://shop.example.com/store">Cửa hàng</a></p>
<p><a href="{{ unsubscribe_url }}">Hủy đăng ký</a></p></body></html>`;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

async function signIn(page: Page, who = "admin@example.com") {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(who);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(who);
}

test.describe.configure({ mode: "serial" });

test("public tracking endpoints: unknown tokens are 404, never a redirect or a sign-in page", async ({ request }) => {
  const o = await request.get(`/o/${"A".repeat(22)}.gif`, { maxRedirects: 0 });
  expect(o.status()).toBe(404);
  const c = await request.get(`/c/${"A".repeat(22)}/0?url=https://evil.example`, { maxRedirects: 0 });
  expect(c.status()).toBe(404);
  expect(c.headers()["location"]).toBeUndefined();
  expect((await request.get("/c/bad/0", { maxRedirects: 0 })).status()).toBe(404);
});

test.describe("mock sending", () => {
  test.skip(MODE !== "mock", "needs the SEND_MODE=mock stack (npm run e2e:mock-campaign)");
  let campaignId = "";

  test("OR-TRK-01: opens and clicks over HTTP; redirect only to the snapshot URL; recorded vs filtered; timeline", async ({ page, request }) => {
    // The test waits ~17 s on purpose (fast-click and burst windows) on top of a send: 30 s was too tight (M8 slow run).
    test.setTimeout(120_000);
    for (let i = 0; i < 2; i++) {
      const e = `${TAG}-${i}@example.com`;
      await q(`insert into contacts (notion_page_id, full_name, greeting_name, email, email_normalized, email_status, tags) values ($1, $2, $3, $4, $4, 'valid', $5)`, [`e2e-${TAG}-${i}`, `Người nhận ${i}`, `Anh ${i}`, e, [TAG]]);
      for (const purpose of ["marketing_email", "email_tracking"]) {
        await q(`insert into consent_records (email_normalized, purpose, status, source, recorded_by, evidence_ref) values ($1, $2, 'granted', 'staff_entry', 'e2e', 'E2E-FORM')`, [e, purpose]);
      }
    }
    await signIn(page);
    const name = `M7 email ${RUN}`;
    await page.goto("/templates");
    await page.getByTestId("import-html").fill(HTML);
    await page.getByTestId("import-name").fill(name);
    await page.getByTestId("import-submit").click();
    await expect(page.getByTestId("version-info")).toContainText("Version 1");
    await page.getByTestId("subject-input").fill("[QC] Theo dõi M7");
    await page.getByTestId("subject-save").click();
    await expect(page.getByTestId("version-info")).toContainText("Version 2");
    await page.goto("/campaigns");
    await page.getByTestId("campaign-name").fill(`M7 theo dõi ${RUN}`);
    await page.getByTestId("campaign-template").selectOption({ label: `${name} (v2)` });
    await page.getByTestId("audience-tags").check();
    await page.getByRole("checkbox", { name: TAG }).check();
    await page.getByTestId("campaign-create").click();
    await expect(page.getByTestId("campaign-status")).toHaveText("draft"); // wait for the new draft's page
    campaignId = page.url().split("?")[0].split("/").pop()!;
    await page.getByTestId("send-now-confirm").check();
    await page.getByTestId("send-now").click();
    await expect(page.getByTestId("campaign-status")).toHaveText("completed", { timeout: 60_000 });

    const msgs = await q<{ id: string; tracking_token: string; tracking_enabled: boolean; email_normalized: string }>(
      `select id, tracking_token, tracking_enabled, email_normalized from messages where campaign_id = $1 order by email_normalized`,
      [campaignId],
    );
    expect(msgs.map((m) => m.tracking_enabled)).toEqual([true, true]);
    const [m0, m1] = msgs;
    const links = await q<{ idx: number; url: string }>(`select l.idx, l.url from campaign_links l join campaigns c on c.snapshot_id = l.snapshot_id where c.id = $1 order by l.idx`, [campaignId]);
    expect(links.map((l) => l.url)).toEqual(["https://shop.example.com/sale?utm=m7", "https://shop.example.com/store"]);

    // Wait past the 10-second "fast click" window so these count as human activity.
    await new Promise((r) => setTimeout(r, 11_000));
    const human = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };
    const open = await request.get(`/o/${m0.tracking_token}.gif`, { headers: human });
    expect(open.status()).toBe(200);
    expect(open.headers()["content-type"]).toBe("image/gif");
    expect(open.headers()["cache-control"]).toContain("no-store");
    for (let k = 0; k < 3; k++) {
      const r = await request.get(`/c/${m0.tracking_token}/0`, { headers: human, maxRedirects: 0 });
      expect(r.status()).toBe(302);
      expect(r.headers()["location"]).toBe(links[0].url);
      await new Promise((res) => setTimeout(res, 2_100)); // outside the 2 s burst window
    }
    // query string is never a destination
    const inj = await request.get(`/c/${m0.tracking_token}/1?url=https://evil.example`, { headers: human, maxRedirects: 0 });
    expect(inj.headers()["location"]).toBe(links[1].url);
    // tampered token and out-of-range index
    const bad = (m0.tracking_token[0] === "A" ? "B" : "A") + m0.tracking_token.slice(1);
    expect((await request.get(`/c/${bad}/0`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await request.get(`/c/${m0.tracking_token}/7`, { maxRedirects: 0 })).status()).toBe(404);
    // automated activity on the second recipient: a HEAD pre-check and a scanner
    expect((await request.head(`/c/${m1.tracking_token}/0`, { headers: human, maxRedirects: 0 })).status()).toBe(302);
    expect((await request.get(`/c/${m1.tracking_token}/0`, { headers: { "user-agent": "Mozilla/5.0 (compatible; Proofpoint URL Defense)" }, maxRedirects: 0 })).status()).toBe(302);

    await page.goto(`/campaigns/${campaignId}#analytics`);
    await expect(page.getByTestId("analytics-card")).toBeVisible();
    await expect(page.getByTestId("an-openers")).toHaveText("1");
    await expect(page.getByTestId("an-clickers")).toHaveText("1");
    const links0 = page.getByTestId("analytics-links").locator("tbody tr").first();
    await expect(links0).toContainText("Xem ưu đãi");
    await expect(links0.locator("td.num").nth(1)).toHaveText("1"); // unique (filtered)
    await expect(links0.locator("td.num").nth(2)).toHaveText("3"); // clicks (filtered)
    const cmp = page.getByTestId("analytics-compare");
    await expect(cmp.locator("tr", { hasText: "Unique clickers" })).toContainText(/2\s*1/); // recorded 2, filtered 1
    await expect(cmp.locator("tr", { hasText: "Clicks (recorded)" })).toContainText(/6\s*4/); // 3+1 human (+2 automated)
    // implied opens: recipient 1 only "clicked" (scanner/HEAD), so recorded openers = 2 and CTOR stays ≤ 100%
    await expect(cmp.locator("tr", { hasText: "Unique openers" })).toContainText(/2\s*1/);
    await expect(cmp.locator("tr", { hasText: "Click-to-open (CTOR)" })).toContainText(/100\.0%\s*100\.0%/);
    await page.screenshot({ path: path.join(SHOTS, "m7-01-analytics-filtered.png"), fullPage: true });
    await page.getByTestId("activity-recorded").click();
    await expect(page.getByTestId("an-clickers")).toHaveText("2");
    await page.screenshot({ path: path.join(SHOTS, "m7-02-analytics-recorded.png"), fullPage: true });

    await page.goto(`/campaigns/${campaignId}/messages/${m1.id}`);
    await expect(page.getByTestId("timeline-table")).toContainText("head request");
    await expect(page.getByTestId("timeline-table")).toContainText("scanner ua");
    await page.goto(`/campaigns/${campaignId}/messages/${m0.id}`);
    await expect(page.getByTestId("timeline-table")).toContainText(links[0].url);
    await expect(page.getByTestId("timeline-activity")).not.toContainText("First activity: —");
    await page.screenshot({ path: path.join(SHOTS, "m7-03-recipient-timeline.png"), fullPage: true });
  });

  test("OR-ROLE-01: a member can create and review, but cannot schedule or send (confirmed role rule)", async ({ page }) => {
    await signIn(page, "member@example.com");
    await page.goto("/campaigns");
    await page.getByTestId("campaign-name").fill(`M7 member ${RUN}`);
    await page.getByTestId("campaign-template").selectOption({ label: `M7 email ${RUN} (v2)` });
    await page.getByTestId("audience-tags").check();
    await page.getByRole("checkbox", { name: TAG }).check();
    await page.getByTestId("campaign-create").click();
    await expect(page.getByTestId("campaign-status")).toHaveText("draft");
    await expect(page.getByTestId("campaign-review")).toBeVisible();
    await expect(page.getByTestId("send-now")).toHaveCount(0);
    await expect(page.getByTestId("schedule-card")).toHaveCount(0);
    await page.goto(`/campaigns/${campaignId}`);
    await expect(page.getByTestId("campaign-cancel")).toHaveCount(0);
  });
});
