/**
 * M2 E2E: Notion connection, sync, contacts, data issues and consent — through the browser,
 * against a production build + worker + the LOCAL MOCK Notion server seeded with SYNTHETIC
 * contacts (scripts/local-stack.ts). MOCK: this does not prove the live Notion API works.
 */
import { expect, test, type Page } from "@playwright/test";

const MOCK = `http://127.0.0.1:${process.env.NOTION_MOCK_PORT ?? 4011}/__mock`;
const MOCK_TOKEN = "mock-notion-token-not-a-secret";
const MOCK_DB = "https://www.notion.so/acme/CRM-11111111222243338444555555555555?v=abc";

async function evidence(page: Page, name: string) {
  await page.screenshot({ path: `test-results/evidence/${name}.png`, fullPage: true });
}

async function devSignIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(email);
}

/** Trigger a sync from the UI and wait until a new run has finished. */
async function syncNow(page: Page, kind: "sync-now" | "full-sync-now" = "sync-now") {
  await page.goto("/sync");
  const before = await page.getByTestId("sync-run-row").count();
  await page.getByTestId(kind).click();
  await expect(page.getByTestId("flash-ok")).toContainText("queued");
  await expect
    .poll(
      async () => {
        await page.reload();
        const rows = page.getByTestId("sync-run-row");
        if ((await rows.count()) <= before) return "waiting";
        return (await rows.first().locator("td").nth(3).innerText()).trim();
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toMatch(/succeeded|partial|failed/);
  return (await page.getByTestId("sync-run-row").first().innerText()).replace(/\s+/g, " ");
}

test.describe.serial("CRM with mock Notion (synthetic data)", () => {
  test("admin connects the mock Notion database and reviews the mapping", async ({ page }) => {
    await devSignIn(page, "admin@example.com");
    await page.goto("/settings/notion");
    await expect(page.getByTestId("notion-mode")).toContainText("NOTION_MODE=mock");
    await page.getByTestId("notion-token").fill(MOCK_TOKEN);
    await page.getByTestId("notion-database").fill(MOCK_DB);
    await page.getByTestId("connect").click();
    await expect(page.getByTestId("flash-ok")).toContainText("Connected");
    await expect(page.getByTestId("map-email")).toHaveValue("Email");
    await expect(page.getByTestId("map-subscriptionStatus")).toHaveValue("Subscription status");
    await page.getByTestId("save-mapping").click();
    await expect(page.getByTestId("flash-ok")).toContainText("Mapping saved");
    // The stored token is never shown back: the field is empty and only the last 4 characters are displayed.
    await page.reload();
    await expect(page.getByTestId("notion-token")).toHaveValue("");
    await expect(page.getByTestId("connection")).toContainText("…cret");
    await evidence(page, "m2-notion-settings");
  });

  test("first sync imports the synthetic contacts with issues flagged", async ({ page }) => {
    await devSignIn(page, "admin@example.com");
    const run = await syncNow(page, "full-sync-now");
    expect(run).toContain("succeeded");
    await evidence(page, "m2-sync-runs");
    await page.goto("/contacts");
    await expect(page.getByTestId("contact-stats")).toContainText("39 active");
    await expect(page.getByTestId("contact-stats")).toContainText("5 duplicates");
    await expect(page.getByTestId("contact-stats")).toContainText("6 invalid/missing email");
    await expect(page.getByTestId("contact-stats")).toContainText("4 suppressed");
    await expect(page.getByTestId("consent-policy-banner")).toBeVisible();
    await evidence(page, "m2-contacts");

    // Diacritics: a name supplied in NFD is found by an NFC search.
    await page.getByTestId("filter-q").fill("Phạm Thị Thu Hà");
    await page.getByTestId("filter-apply").click();
    await expect(page.getByTestId("result-count")).toContainText("1 contact");

    await page.goto("/contacts?issue=duplicate");
    await expect(page.getByTestId("contact-row")).toHaveCount(5);
  });

  test("data issues: duplicates can be resolved by choosing a primary", async ({ page }) => {
    await devSignIn(page, "admin@example.com");
    await page.goto("/contacts/issues");
    await expect(page.getByTestId("duplicate-group")).toHaveCount(2);
    await expect(page.getByTestId("invalid-emails")).toContainText("multiple_at_signs");
    await expect(page.getByTestId("invalid-emails")).toContainText("non_ascii");
    await expect(page.getByTestId("missing-greeting")).toContainText("Lê Hoàng Phúc");
    const mai = page.getByTestId("duplicate-group").filter({ hasText: "mai.ngo@example.com" });
    await mai.getByTestId("choose-primary").first().click();
    await expect(page.getByTestId("flash-ok")).toContainText("Primary contact chosen");
    await expect(page.getByTestId("duplicate-group").filter({ hasText: "mai.ngo@example.com" })).toContainText("primary chosen");
    await evidence(page, "m2-data-issues");
  });

  test("consent: imported contacts are unknown; a grant needs evidence and is recorded by staff", async ({ page }) => {
    await devSignIn(page, "admin@example.com");
    await page.goto("/contacts?q=Nguy%E1%BB%85n%20V%C4%83n%20An");
    await page.getByRole("link", { name: "Nguyễn Văn An" }).click();
    await expect(page.getByTestId("consent-section")).toContainText("unknown");
    await expect(page.getByTestId("notion-evidence")).toHaveText("Form đăng ký 2026-03-02 #F-1021");
    await expect(page.getByTestId("eligibility")).toContainText("No recorded marketing consent");

    // A grant without evidence is refused.
    await page.getByTestId("consent-submit").click();
    await expect(page.getByTestId("flash-error")).toContainText("evidence");

    await page.getByTestId("consent-evidence").fill("Form đăng ký 2026-03-02 #F-1021 (checked)");
    await page.getByTestId("consent-submit").click();
    await expect(page.getByTestId("flash-ok")).toContainText("Consent record added");
    await expect(page.getByTestId("consent-section")).toContainText("granted");
    await expect(page.getByTestId("consent-history")).toContainText("staff entry");
    await expect(page.getByTestId("consent-history")).toContainText("notion import");
    await expect(page.getByTestId("eligibility")).toContainText("eligible");
    await evidence(page, "m2-contact-consent");
  });

  test("a 'resubscribe' in Notion never removes the suppression and is corrected in Notion", async ({ page, request }) => {
    await devSignIn(page, "admin@example.com");
    const r = await request.patch(`${MOCK}/pages/huy`, { data: { subscription: "Subscribed" } });
    expect(r.ok()).toBe(true);
    expect(await syncNow(page)).toContain("succeeded");
    await page.goto("/contacts?q=Huy&state=all");
    await page.getByRole("link", { name: "Bùi Đức Huy" }).click();
    await expect(page.getByTestId("suppression")).toContainText("notion unsubscribed");
    await expect(page.getByTestId("consent-section")).toContainText("withdrawn");
    // The worker writes "Unsubscribed" back to Notion (outbox flush is triggered by the sync).
    await expect
      .poll(async () => ((await (await request.get(`${MOCK}/pages`)).json()) as Array<{ key: string; subscription: string }>).find((p) => p.key === "huy")?.subscription, {
        timeout: 30_000,
      })
      .toBe("Unsubscribed");
  });

  test("a repeated full sync creates nothing new", async ({ page }) => {
    await devSignIn(page, "admin@example.com");
    const run = await syncNow(page, "full-sync-now");
    expect(run).toContain("succeeded");
    // columns: started, mode, trigger, status, fetched, created, …
    const created = (await page.getByTestId("sync-run-row").first().locator("td").nth(5).innerText()).trim();
    expect(created).toBe("0");
    await page.goto("/contacts");
    await expect(page.getByTestId("contact-stats")).toContainText("39 active");
  });

  test("members can read contacts but cannot change settings or consent", async ({ page }) => {
    await devSignIn(page, "member@example.com");
    await page.goto("/contacts");
    await expect(page.getByTestId("contact-stats")).toContainText("39 active");
    await page.getByRole("link", { name: "Nguyễn Văn An" }).click();
    await expect(page.getByTestId("consent-form")).toHaveCount(0);
    await page.goto("/settings/notion");
    await expect(page).toHaveURL(/\/forbidden$/);
    await page.goto("/sync");
    await expect(page.getByTestId("sync-now")).toHaveCount(0);
  });
});
