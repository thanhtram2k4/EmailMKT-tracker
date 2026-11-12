/**
 * M4 test sends through the UI (Chromium, local stack). MOCK only: the stack refuses real send
 * modes, so nothing ever leaves the machine.
 *  - `npm run e2e`            → SEND_MODE=disabled: R-TS-12 (button off, server refuses)
 *  - `npm run e2e:mock-send`  → SEND_MODE=mock:     OR-TS-01 end to end, R-TS-02 via the UI
 * The allowlist in the stack is the reserved-domain address qa-inbox@example.com.
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const MODE = process.env.SEND_MODE ?? "disabled";
const SHOTS = process.env.TEST_SEND_SHOTS ?? "test-results/test-send/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

const HTML = `<!DOCTYPE html><html><head><title>M4 test-send fixture (SYNTHETIC)</title></head><body>
<table role="presentation" width="100%"><tr><td>
<h1>Bản tin thử nghiệm</h1>
<p>Chào {{ greeting_name | default: "bạn" }}, đây là email thử của {{ company | default: "Quý công ty" }}.</p>
<p><a href="https://example.com/offer">Xem ưu đãi</a> · <a href="{{ unsubscribe_url }}">Hủy đăng ký</a></p>
</td></tr></table></body></html>`;

async function signIn(page: Page, email = "admin@example.com") {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(email);
}

async function importAndSetSubject(page: Page, subject: string) {
  await page.goto("/templates");
  await page.getByTestId("import-html").fill(HTML);
  await page.getByTestId("import-name").fill(`M4 test send ${Date.now()}`);
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  await expect(page.getByTestId("subject-missing")).toBeVisible();
  await expect(page.getByTestId("test-send-needs-subject")).toBeVisible();
  await page.getByTestId("subject-input").fill(subject);
  await page.getByTestId("subject-save").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
  await expect(page.getByTestId("flash-ok")).toContainText("Subject saved as version 2");
}

test("subject preview: fallbacks for each sample; unknown field reported", async ({ page }) => {
  await signIn(page);
  await importAndSetSubject(page, 'Chào {{ greeting_name | default: "bạn" }} — {{ company | default: "quý khách" }}');
  const prev = page.getByTestId("subject-preview");
  await expect(prev.locator('[data-sample="sample-full"]')).toContainText("Chào Anh An — Công ty An Phát");
  await expect(prev.locator('[data-sample="sample-no-company"]')).toContainText("Chào bạn — quý khách");
  await expect(page.getByTestId("personalization-ok")).toBeVisible();
  // Unknown field → blocking problem listed.
  await page.getByTestId("subject-input").fill("Chào {{ first_name }}");
  await page.getByTestId("subject-save").click();
  await expect(page.getByTestId("subject-problems")).toContainText("unknown field");
  await expect(page.getByTestId("personalization-blocking")).toContainText("unknown field");
  // A field without fallback lists the affected CRM contacts. This needs synced contacts: the default
  // e2e run has them (crm.spec syncs the synthetic CRM first); the mock-send stack has none, so there
  // the check must report 0 checked contacts instead (R-PERS-05 itself is covered by integration tests).
  await page.getByTestId("subject-input").fill("Chào {{ greeting_name }}");
  await page.getByTestId("subject-save").click();
  const checkedText = await page.getByTestId("personalization-check").innerText();
  const checked = Number(/Checked against (\d+)/.exec(checkedText)?.[1] ?? "NaN");
  if (checked > 0) {
    await expect(page.getByTestId("personalization-affected-count")).toBeVisible();
  } else {
    test.info().annotations.push({ type: "precondition", description: "no synced contacts in this stack; affected-list UI not exercised here" });
    await expect(page.getByTestId("personalization-ok")).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOTS, "personalization-check.png"), fullPage: true });
});

test.describe("SEND_MODE=disabled", () => {
  test.skip(MODE !== "disabled", "runs in the default e2e stack");
  test("R-TS-12: the button is disabled and the panel explains why", async ({ page }) => {
    await signIn(page);
    await importAndSetSubject(page, 'Chào {{ greeting_name | default: "bạn" }}');
    await expect(page.getByTestId("test-send-availability")).toContainText("sending is disabled");
    await expect(page.getByTestId("test-send-submit")).toBeDisabled();
    await page.getByTestId("test-send-panel").screenshot({ path: path.join(SHOTS, "test-send-disabled.png") });
  });
});

test.describe("SEND_MODE=mock", () => {
  test.skip(MODE !== "mock", "needs `npm run e2e:mock-send`");

  test("OR-TS-01: subject with fallback → preview → send test to the allowlisted inbox → history", async ({ page }) => {
    await signIn(page);
    await importAndSetSubject(page, 'Chào {{ greeting_name | default: "bạn" }}, ưu đãi tháng 11');
    await expect(page.getByTestId("test-send-availability")).toContainText("mock transport");
    await page.getByTestId("test-send-recipients").fill("qa-inbox@example.com");
    await page.getByTestId("test-send-merge-source").selectOption("sample-no-greeting");
    await page.getByTestId("test-send-submit").click();
    const result = page.getByTestId("test-send-result");
    await expect(result).toHaveAttribute("data-status", "accepted");
    await expect(result).toContainText("q***@example.com");
    await expect(page.getByTestId("test-send-results")).toContainText("not proof that it reached the inbox");
    await page.reload();
    const row = page.getByTestId("test-send-row").first();
    await expect(row).toHaveAttribute("data-status", "accepted");
    await expect(row).toContainText("[TEST] Chào bạn, ưu đãi tháng 11");
    await expect(row).toContainText("mock");
    await page.getByTestId("test-send-panel").screenshot({ path: path.join(SHOTS, "test-send-mock-accepted.png") });
  });

  test("R-TS-02 (UI): a typed address that is not allowlisted is refused and not sent", async ({ page }) => {
    await signIn(page);
    await importAndSetSubject(page, 'Chào {{ greeting_name | default: "bạn" }}');
    await page.getByTestId("test-send-recipients").fill("someone-else@example.net");
    await page.getByTestId("test-send-submit").click();
    const result = page.getByTestId("test-send-result");
    await expect(result).toHaveAttribute("data-status", "refused");
    await expect(result).toContainText("not on the list of permitted test recipients");
    await expect(result).not.toContainText("qa-inbox");
    await page.getByTestId("test-send-panel").screenshot({ path: path.join(SHOTS, "test-send-mock-refused.png") });
  });

  test("a missing value without fallback blocks the send and lists the problem", async ({ page }) => {
    await signIn(page);
    await importAndSetSubject(page, "Chào {{ greeting_name }}");
    await page.getByTestId("test-send-recipients").fill("qa-inbox@example.com");
    await page.getByTestId("test-send-merge-source").selectOption("sample-no-greeting");
    await page.getByTestId("test-send-submit").click();
    await expect(page.getByTestId("test-send-error")).toContainText("greeting_name: no value");
  });
});
