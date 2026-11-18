/**
 * M8 security checks against the running app (any send mode; synthetic data).
 *  - SEC-01 security headers; no X-Powered-By;
 *  - SEC-02 CSRF: a Server Function form posted with a foreign Origin is refused; the same request with
 *           the app's own Origin works (so the test exercises the real action);
 *  - SEC-03 session cookie is HttpOnly and SameSite=Lax;
 *  - SEC-04 public endpoints are rate limited per client (the local stack trusts one proxy hop, so
 *           X-Forwarded-For's right-most entry identifies the client; a forged left-most entry does not help).
 */
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const RUN = Date.now().toString(36);

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

test("SEC-01: security headers on app pages and public endpoints", async ({ request }) => {
  for (const path of ["/sign-in", `/u/${"A".repeat(22)}`]) {
    const r = await request.get(path, { maxRedirects: 0 });
    const h = r.headers();
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["x-frame-options"], path).toBe("SAMEORIGIN");
    expect(h["referrer-policy"], path).toBeTruthy();
    expect(h["permissions-policy"], path).toContain("camera=()");
    expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(h["x-powered-by"], path).toBeUndefined();
  }
});

test("SEC-02: a Server Function form posted from a foreign origin is refused (CSRF)", async ({ page }) => {
  await signIn(page);
  // Make sure an email exists to create a campaign from.
  await page.goto("/templates");
  await page.getByTestId("import-html").fill('<p>CSRF probe</p><a href="{{ unsubscribe_url }}">u</a>');
  await page.getByTestId("import-name").fill(`SEC ${RUN}`);
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  await page.goto("/campaigns");
  const form = page.getByTestId("new-campaign").locator("form");
  const actionField = await form.locator('input[name^="$ACTION_ID_"]').getAttribute("name");
  expect(actionField).toMatch(/^\$ACTION_ID_[0-9a-f]+$/);
  const templateId = await page.getByTestId("campaign-template").locator("option").first().getAttribute("value");
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const base = new URL(page.url()).origin;
  const post = (origin: string, name: string) =>
    page.request.post("/campaigns", {
      headers: { origin, cookie: cookies },
      multipart: { [actionField!]: "", name, templateId: templateId!, audienceKind: "all_eligible" },
      maxRedirects: 0,
    });
  const evil = await post("https://evil.example", `CSRF evil ${RUN}`);
  expect(evil.status()).toBeGreaterThanOrEqual(400);
  expect(await q(`select 1 from campaigns where name = $1`, [`CSRF evil ${RUN}`])).toHaveLength(0);
  const own = await post(base, `CSRF own ${RUN}`);
  expect(own.status()).toBeLessThan(400);
  expect(await q(`select 1 from campaigns where name = $1`, [`CSRF own ${RUN}`])).toHaveLength(1);
});

test("SEC-03: the session cookie is HttpOnly and SameSite=Lax", async ({ page }) => {
  await signIn(page);
  const session = (await page.context().cookies()).find((c) => /session_token/.test(c.name));
  expect(session, "session cookie").toBeTruthy();
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite).toBe("Lax");
});

test("SEC-04: public endpoints are rate limited per client; a forged X-Forwarded-For entry does not bypass it", async ({ request }) => {
  const token = "Z".repeat(22); // unknown token: 404 while under the limit
  const client = { "x-forwarded-for": "198.51.100.77" };
  const statuses: number[] = [];
  for (let i = 0; i < 61; i++) statuses.push((await request.get(`/u/${token}`, { headers: client })).status());
  expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
  expect(statuses[60]).toBe(429);
  const blocked = await request.get(`/u/${token}`, { headers: client });
  expect(blocked.status()).toBe(429);
  expect(Number(blocked.headers()["retry-after"])).toBeGreaterThan(0);
  // forged left-most entry, same real client (right-most, appended by the trusted proxy) → still limited
  expect((await request.get(`/u/${token}`, { headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.77" } })).status()).toBe(429);
  // another client is unaffected
  expect((await request.get(`/u/${token}`, { headers: { "x-forwarded-for": "198.51.100.78" } })).status()).toBe(404);
});
