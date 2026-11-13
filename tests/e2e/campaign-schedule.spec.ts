/**
 * M6 scheduling through the UI (Chromium, local stack, synthetic data). MOCK only.
 *  - `npm run e2e`                 → SEND_MODE=disabled: the schedule card is blocked like Send now;
 *  - `npm run e2e:mock-campaign`   → SEND_MODE=mock:
 *      OR-SCH-01 time validation in the UI (past, DST gap with suggestion, DST overlap choice), then a
 *                real schedule ~4 minutes ahead; the BROWSER IS CLOSED and the stack's worker must
 *                start it within 60 s of the target and complete it (S7, MOCK);
 *      OR-SCH-02 reschedule (revision++) and cancel (never dispatched, start job removed);
 *      OR-SCH-03 unschedule → draft with the "Schedule removed" banner;
 *      OR-SCH-04 a simulated outage (scheduled time moved 40 min into the past in the DB) → the worker's
 *                sweeper holds it (held_overdue, not sent) and alerts; an admin then sends it now.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const MODE = process.env.SEND_MODE ?? "disabled";
const SHOTS = process.env.CAMPAIGN_SHOTS ?? "test-results/campaign-schedule/screenshots";
mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);
const TAG = `e2e-m6-${RUN}`;
const HCM = "Asia/Ho_Chi_Minh";
const HTML = `<!DOCTYPE html><html><head><title>M6 schedule fixture (SYNTHETIC)</title></head><body>
<p>Chào {{ greeting_name | default: "Quý khách" }}, ưu đãi cuối tuần.</p>
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

/** Local date/time strings in a zone for an instant. */
function local(d: Date, zone = HCM) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function signIn(page: Page, who = "admin@example.com") {
  await page.context().clearCookies(); // switching user: /sign-in redirects away while signed in
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(who);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(who);
}

let emailName = "";
async function draft(page: Page, name: string) {
  await page.goto("/campaigns");
  await page.getByTestId("campaign-name").fill(name);
  await page.getByTestId("campaign-template").selectOption({ label: `${emailName} (v2)` });
  await page.getByTestId("audience-tags").check();
  await page.getByRole("checkbox", { name: TAG }).check();
  await page.getByTestId("campaign-create").click();
  await expect(page.getByTestId("campaign-status")).toHaveText("draft");
  return page.url().split("?")[0].split("/").pop()!;
}

async function pick(page: Page, date: string, time: string, zone = HCM) {
  await page.getByTestId("schedule-date").fill(date);
  await page.getByTestId("schedule-time").fill(time);
  await page.getByTestId("schedule-zone").selectOption(zone);
  await page.getByTestId("schedule-check").click();
}

async function confirm(page: Page) {
  await page.getByTestId("schedule-confirm").check();
  await page.getByTestId("schedule-submit").click();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  for (let i = 0; i < 3; i++) {
    const e = `${TAG}-${i}@example.com`;
    await q(`insert into contacts (notion_page_id, full_name, greeting_name, email, email_normalized, email_status, tags) values ($1, $2, $3, $4, $4, 'valid', $5)`, [`e2e-${TAG}-${i}`, `Người nhận ${i}`, i === 2 ? null : `Anh ${i}`, e, [TAG]]);
    await q(`insert into consent_records (email_normalized, purpose, status, source, recorded_by, evidence_ref) values ($1, 'marketing_email', 'granted', 'staff_entry', 'e2e', 'E2E-FORM')`, [e]);
  }
});

test("each campaign page shows the schedule card for admins only; disabled mode blocks it", async ({ page }) => {
  await signIn(page);
  emailName = `M6 email ${RUN}`;
  await page.goto("/templates");
  await page.getByTestId("import-html").fill(HTML);
  await page.getByTestId("import-name").fill(emailName);
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  await page.getByTestId("subject-input").fill('[QC] Cuối tuần cho {{ greeting_name | default: "bạn" }}');
  await page.getByTestId("subject-save").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
  await draft(page, `M6 card ${RUN}`);
  await expect(page.getByTestId("schedule-card")).toBeVisible();
  if (MODE === "disabled") await expect(page.getByTestId("schedule-card")).toContainText("Fix the problems listed in the review first");
  else await expect(page.getByTestId("schedule-form")).toBeVisible();
  await signIn(page, "member@example.com");
  await page.goto("/campaigns/scheduled");
  await expect(page.getByRole("heading", { name: /upcoming/ })).toBeVisible();
});

test.describe("mock sending", () => {
  test.skip(MODE !== "mock", "needs the SEND_MODE=mock stack (npm run e2e:mock-campaign)");

  test("OR-SCH-01: validation in the UI, then a schedule that the worker runs with the browser closed (S7, MOCK)", async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page);
    const id = await draft(page, `M6 lịch ${RUN}`);

    // Past time
    const yesterday = local(new Date(Date.now() - 86_400_000));
    await pick(page, yesterday.date, "09:00");
    await expect(page.getByTestId("schedule-error")).toContainText("in the past");
    // DST gap in New York (14 Mar 2027): rejected with a suggestion that can be followed
    await pick(page, "2027-03-14", "02:30", "America/New_York");
    await expect(page.getByTestId("schedule-error")).toContainText("does not exist");
    await page.getByTestId("schedule-suggestion").click();
    await expect(page.getByTestId("schedule-local")).toContainText("2027-03-14 03:30 (America/New_York, UTC-04:00)");
    // DST overlap (7 Nov 2027): two choices; picking the second shows UTC-05:00
    await pick(page, "2027-11-07", "01:30", "America/New_York");
    await expect(page.getByTestId("schedule-error")).toContainText("happens twice");
    await expect(page.getByTestId("schedule-option")).toHaveCount(2);
    await page.getByTestId("schedule-option").nth(1).click();
    await expect(page.getByTestId("schedule-local")).toContainText("UTC-05:00");
    await expect(page.getByTestId("schedule-utc")).toContainText("2027-11-07 06:30 UTC");
    await page.screenshot({ path: path.join(SHOTS, "m6-01-dst-overlap-choice.png"), fullPage: true });

    // The real schedule: a whole minute at least ~4 minutes ahead, in Ho Chi Minh time.
    const target = new Date(Math.ceil((Date.now() + 4 * 60_000) / 60_000) * 60_000);
    const t = local(target);
    await pick(page, t.date, t.time);
    await expect(page.getByTestId("schedule-summary")).toContainText(`${t.date} ${t.time} (Asia/Ho_Chi_Minh, UTC+07:00)`);
    await expect(page.getByTestId("schedule-utc")).toContainText(target.toISOString().slice(11, 16));
    await expect(page.getByTestId("schedule-summary")).toContainText("Recipients3");
    await page.screenshot({ path: path.join(SHOTS, "m6-02-confirm-summary.png"), fullPage: true });
    await confirm(page);
    await expect(page.getByTestId("flash-ok")).toContainText("Scheduled: 3 message(s)");
    await expect(page.getByTestId("campaign-status")).toHaveText("scheduled");
    await expect(page.getByTestId("schedule-when")).toContainText(`(Asia/Ho_Chi_Minh, UTC+07:00) = ${target.toISOString().slice(11, 16)} UTC`);
    await page.goto("/campaigns/scheduled");
    const row = page.getByTestId("scheduled-row").filter({ hasText: `M6 lịch ${RUN}` });
    await expect(row).toContainText(`${t.date} ${t.time}`);
    await expect(row).toContainText("scheduled");
    await page.screenshot({ path: path.join(SHOTS, "m6-03-scheduled-list.png"), fullPage: true });

    // Close the browser context: from here on only the worker process acts.
    await ctx.close();
    let status = "";
    const deadline = target.getTime() + 150_000;
    while (Date.now() < deadline) {
      status = (await q<{ s: string }>(`select status::text as s from campaigns where id = $1`, [id]))[0].s;
      if (status === "completed" || status === "completed_with_issues") break;
      // No early dispatch: before the target the campaign must still be scheduled.
      if (Date.now() < target.getTime() - 1000) expect(status).toBe("scheduled");
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(status).toBe("completed");
    const c = (await q<{ started: Date; scheduled: Date; delay: number }>(`select processing_started_at as started, scheduled_at_utc as scheduled, start_delay_ms as delay from campaigns where id = $1`, [id]))[0];
    expect(new Date(c.started).getTime()).toBeGreaterThanOrEqual(new Date(c.scheduled).getTime());
    expect(c.delay).toBeLessThan(60_000);
    expect((await q<{ n: number }>(`select count(*)::int as n from messages where campaign_id = $1 and send_status = 'sent'`, [id]))[0].n).toBe(3);
    test.info().annotations.push({ type: "S7-mock", description: `scheduled ${target.toISOString()} · started ${new Date(c.started).toISOString()} · delay ${c.delay} ms · browser closed` });

    const page2 = await (await browser.newContext()).newPage();
    await signIn(page2);
    await page2.goto(`/campaigns/${id}`);
    await expect(page2.getByTestId("schedule-actual")).toContainText("s after the scheduled time");
    await page2.screenshot({ path: path.join(SHOTS, "m6-04-completed-actual-start.png"), fullPage: true });
  });

  test("OR-SCH-02: reschedule increments the revision; cancel means never dispatched and the start job is removed", async ({ page }) => {
    await signIn(page);
    const id = await draft(page, `M6 dời lịch ${RUN}`);
    const t1 = local(new Date(Date.now() + 30 * 60_000));
    await pick(page, t1.date, t1.time);
    await confirm(page);
    await expect(page.getByTestId("schedule-revision")).toHaveText("0");
    const t2 = local(new Date(Date.now() + 90 * 60_000));
    await pick(page, t2.date, t2.time);
    await expect(page.getByTestId("schedule-summary")).toContainText("Confirm the new time");
    await confirm(page);
    await expect(page.getByTestId("flash-ok")).toContainText("Rescheduled");
    await expect(page.getByTestId("schedule-revision")).toHaveText("1");
    await expect(page.getByTestId("schedule-when")).toContainText(t2.time);
    const jobs = await q<{ n: number }>(`select count(*)::int as n from graphile_worker.jobs where key = $1`, [`start:${id}`]);
    expect(jobs[0].n).toBe(1);
    await page.screenshot({ path: path.join(SHOTS, "m6-05-rescheduled.png"), fullPage: true });
    await page.getByTestId("campaign-cancel-confirm").check();
    await page.getByTestId("campaign-cancel").click();
    await expect(page.getByTestId("campaign-status")).toHaveText("cancelled");
    expect((await q<{ n: number }>(`select count(*)::int as n from graphile_worker.jobs where key = $1`, [`start:${id}`]))[0].n).toBe(0);
    expect((await q<{ n: number }>(`select count(*)::int as n from messages where campaign_id = $1 and send_status <> 'cancelled'`, [id]))[0].n).toBe(0);
  });

  test("OR-SCH-03: unschedule returns the campaign to draft with a clear banner", async ({ page }) => {
    await signIn(page);
    await draft(page, `M6 sửa ${RUN}`);
    const t = local(new Date(Date.now() + 45 * 60_000));
    await pick(page, t.date, t.time);
    await confirm(page);
    await page.getByTestId("campaign-unschedule").click();
    await expect(page.getByTestId("flash-ok")).toContainText("Schedule removed — review and confirm again");
    await expect(page.getByTestId("campaign-status")).toHaveText("draft");
    await expect(page.getByTestId("campaign-edit")).toBeVisible();
  });

  test("OR-SCH-04: after a (simulated) outage beyond the grace period the worker holds the campaign and alerts; an admin sends it now", async ({ page }) => {
    test.setTimeout(4 * 60_000);
    await signIn(page);
    const id = await draft(page, `M6 trễ ${RUN}`);
    const t = local(new Date(Date.now() + 30 * 60_000));
    await pick(page, t.date, t.time);
    await confirm(page);
    // Simulate the worker having been down: the scheduled moment is now 40 minutes in the past.
    await q(`update campaigns set scheduled_at_utc = now() - interval '40 minutes' where id = $1`, [id]);
    let status = "";
    for (let k = 0; k < 90 && status !== "held_overdue"; k++) {
      status = (await q<{ s: string }>(`select status::text as s from campaigns where id = $1`, [id]))[0].s;
      if (status !== "held_overdue") await new Promise((r) => setTimeout(r, 1000));
    }
    expect(status).toBe("held_overdue");
    expect((await q<{ n: number }>(`select count(*)::int as n from messages where campaign_id = $1 and send_status = 'sent'`, [id]))[0].n).toBe(0);
    await page.goto("/");
    await expect(page.getByTestId("admin-alerts")).toContainText(`M6 trễ ${RUN}`);
    await page.goto(`/campaigns/${id}`);
    await expect(page.getByTestId("campaign-held")).toContainText("beyond the 30-minute grace period");
    await page.screenshot({ path: path.join(SHOTS, "m6-06-held-overdue.png"), fullPage: true });
    await page.getByTestId("overdue-confirm").check();
    await page.getByTestId("overdue-send-now").click();
    await expect(page.getByTestId("flash-ok")).toContainText("Released");
    await expect(page.getByTestId("campaign-status")).toHaveText("completed", { timeout: 60_000 });
    await page.goto("/");
    await page.getByTestId("admin-alerts").getByTestId("alert-ack").first().click();
  });
});
