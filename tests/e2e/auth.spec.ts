/**
 * M1 E2E: staff sign-in through the browser, using the LOCAL-ONLY dev identity provider
 * (APP_ENV=test). These are MOCK-identity tests: they prove the app's domain + allowlist
 * gate, role display, admin-only page and sign-out. They do NOT prove Google OAuth works —
 * that requires a real OAuth client and is reported separately as BLOCKED.
 */
import { expect, test, type Page } from "@playwright/test";

/** Explicit evidence screenshots for the test report (fixture data only). */
async function evidence(page: Page, name: string) {
  await page.screenshot({ path: `test-results/evidence/${name}.png`, fullPage: true });
}

async function devSignIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-sign-in").click();
}

test("unauthenticated visitors are redirected to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByTestId("google-sign-in")).toBeDisabled(); // no OAuth client in this environment
});

test("allowlisted admin signs in, sees role and admin page, signs out", async ({ page }) => {
  await devSignIn(page, "admin@example.com");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("current-user")).toContainText("admin@example.com");
  await expect(page.getByTestId("current-role")).toHaveText("admin");
  await expect(page.getByTestId("send-mode-banner")).toContainText("SEND_MODE=disabled");
  await expect(page.getByTestId("health-card")).toContainText("running");
  await evidence(page, "admin-dashboard");

  await page.goto("/staff");
  await expect(page.getByTestId("staff-list")).toContainText("member@example.com");
  await expect(page.getByTestId("audit-list")).toContainText("auth.sign_in");
  await evidence(page, "admin-staff-and-audit");

  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("allowlisted member signs in but cannot open the admin page", async ({ page }) => {
  await devSignIn(page, "member@example.com");
  await expect(page.getByTestId("current-role")).toHaveText("member");
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await evidence(page, "member-forbidden");
});

for (const [email, code] of [
  ["stranger@example.com", "ACCESS_DENIED_NOT_ALLOWLISTED"],
  ["outsider@example.net", "ACCESS_DENIED_WRONG_DOMAIN"],
  ["revoked@example.com", "ACCESS_DENIED_DISABLED"],
] as const) {
  test(`${email} is rejected (${code})`, async ({ page }) => {
    await devSignIn(page, email);
    await expect(page).toHaveURL(/\/access-denied/);
    await expect(page.getByTestId("denial-code")).toHaveText(code);
    await evidence(page, `denied-${code.toLowerCase()}`);
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/); // no session was created
  });
}

test("revoking a signed-in member ends the session and blocks the next sign-in", async ({ page }) => {
  await devSignIn(page, "member2@example.com");
  await expect(page.getByTestId("current-role")).toHaveText("member");

  const { getDb, closeDb } = await import("../../src/lib/db/client");
  const { disableStaff } = await import("../../src/lib/staff");
  await disableStaff(getDb(process.env.DATABASE_URL), { email: "member2@example.com", actor: "e2e-test" });
  await closeDb();

  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await devSignIn(page, "member2@example.com");
  await expect(page).toHaveURL(/\/access-denied/);
  await expect(page.getByTestId("denial-code")).toHaveText("failed_to_create_session");
  await expect(page.getByTestId("access-denied")).toContainText("does not currently have access");
  await evidence(page, "revoked-midsession-denied");
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("healthz reports database and worker", async ({ request }) => {
  const r = await request.get("/healthz");
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe("ok");
  expect(body.checks.database.ok).toBe(true);
  expect(body.checks.worker.ok).toBe(true);
  expect(body.checks.worker.ageSeconds).toBeLessThanOrEqual(60);
  expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
});
