# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.ts >> revoking a signed-in member ends the session and blocks the next sign-in
- Location: tests\e2e\auth.spec.ts:61:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByTestId('current-role')
Expected: "member"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toHaveText" getByTestId('current-role') with timeout 5000ms
  - waiting for getByTestId('current-role')
    - waiting for "http://localhost:3100/api/auth/magic-link/verify?token=[REDACTED]&callbackURL=%2F&errorCallbackURL=%2Faccess-denied" navigation to finish...
    - navigated to "http://localhost:3100/api/auth/magic-link/verify?token=[REDACTED]&callbackURL=%2F&errorCallbackURL=%2Faccess-denied"

```

```yaml
- text: "{\"message\":\"Too many requests. Please try again later.\"}"
```

# Test source

```ts
  1  | /**
  2  |  * M1 E2E: staff sign-in through the browser, using the LOCAL-ONLY dev identity provider
  3  |  * (APP_ENV=test). These are MOCK-identity tests: they prove the app's domain + allowlist
  4  |  * gate, role display, admin-only page and sign-out. They do NOT prove Google OAuth works —
  5  |  * that requires a real OAuth client and is reported separately as BLOCKED.
  6  |  */
  7  | import { expect, test, type Page } from "@playwright/test";
  8  | 
  9  | async function devSignIn(page: Page, email: string) {
  10 |   await page.goto("/sign-in");
  11 |   await page.getByTestId("dev-email").fill(email);
  12 |   await page.getByTestId("dev-sign-in").click();
  13 | }
  14 | 
  15 | test("unauthenticated visitors are redirected to sign-in", async ({ page }) => {
  16 |   await page.goto("/");
  17 |   await expect(page).toHaveURL(/\/sign-in$/);
  18 |   await expect(page.getByTestId("google-sign-in")).toBeDisabled(); // no OAuth client in this environment
  19 | });
  20 | 
  21 | test("allowlisted admin signs in, sees role and admin page, signs out", async ({ page }) => {
  22 |   await devSignIn(page, "a***@example.com");
  23 |   await expect(page).toHaveURL(/\/$/);
  24 |   await expect(page.getByTestId("current-user")).toContainText("a***@example.com");
  25 |   await expect(page.getByTestId("current-role")).toHaveText("admin");
  26 |   await expect(page.getByTestId("send-mode-banner")).toContainText("SEND_MODE=disabled");
  27 |   await expect(page.getByTestId("health-card")).toContainText("running");
  28 | 
  29 |   await page.goto("/staff");
  30 |   await expect(page.getByTestId("staff-list")).toContainText("m***@example.com");
  31 |   await expect(page.getByTestId("audit-list")).toContainText("auth.sign_in");
  32 | 
  33 |   await page.getByTestId("sign-out").click();
  34 |   await expect(page).toHaveURL(/\/sign-in$/);
  35 |   await page.goto("/");
  36 |   await expect(page).toHaveURL(/\/sign-in$/);
  37 | });
  38 | 
  39 | test("allowlisted member signs in but cannot open the admin page", async ({ page }) => {
  40 |   await devSignIn(page, "m***@example.com");
  41 |   await expect(page.getByTestId("current-role")).toHaveText("member");
  42 |   await page.goto("/staff");
  43 |   await expect(page).toHaveURL(/\/forbidden$/);
  44 |   await expect(page.getByTestId("forbidden")).toBeVisible();
  45 | });
  46 | 
  47 | for (const [email, code] of [
  48 |   ["s***@example.com", "ACCESS_DENIED_NOT_ALLOWLISTED"],
  49 |   ["o***@example.net", "ACCESS_DENIED_WRONG_DOMAIN"],
  50 |   ["r***@example.com", "ACCESS_DENIED_DISABLED"],
  51 | ] as const) {
  52 |   test(`${email} is rejected (${code})`, async ({ page }) => {
  53 |     await devSignIn(page, email);
  54 |     await expect(page).toHaveURL(/\/access-denied/);
  55 |     await expect(page.getByTestId("denial-code")).toHaveText(code);
  56 |     await page.goto("/");
  57 |     await expect(page).toHaveURL(/\/sign-in$/); // no session was created
  58 |   });
  59 | }
  60 | 
  61 | test("revoking a signed-in member ends the session and blocks the next sign-in", async ({ page }) => {
  62 |   await devSignIn(page, "m***@example.com");
> 63 |   await expect(page.getByTestId("current-role")).toHaveText("member");
     |                                                  ^ Error: expect(locator).toHaveText(expected) failed
  64 | 
  65 |   const { getDb, closeDb } = await import("../../src/lib/db/client");
  66 |   const { disableStaff } = await import("../../src/lib/staff");
  67 |   await disableStaff(getDb(process.env.DATABASE_URL), { email: "m***@example.com", actor: "e2e-test" });
  68 |   await closeDb();
  69 | 
  70 |   await page.goto("/");
  71 |   await expect(page).toHaveURL(/\/sign-in$/);
  72 |   await devSignIn(page, "m***@example.com");
  73 |   await expect(page).toHaveURL(/\/access-denied/);
  74 |   await expect(page.getByTestId("denial-code")).toHaveText("ACCESS_DENIED_DISABLED");
  75 | });
  76 | 
  77 | test("healthz reports database and worker", async ({ request }) => {
  78 |   const r = await request.get("/healthz");
  79 |   expect(r.status()).toBe(200);
  80 |   const body = await r.json();
  81 |   expect(body.status).toBe("ok");
  82 |   expect(body.checks.database.ok).toBe(true);
  83 |   expect(body.checks.worker.ok).toBe(true);
  84 |   expect(body.checks.worker.ageSeconds).toBeLessThanOrEqual(60);
  85 |   expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
  86 | });
  87 | 
```