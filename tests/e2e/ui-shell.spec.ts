/**
 * M4 UI redesign regression (R-UI-01…06) in Chromium against the local stack (MOCK identity: dev
 * sign-in; SEND_MODE=disabled). Expected behaviour: PROJECT_BRIEF QA §A, docs/PLAN.md M4.
 * Screenshots (light/dark, desktop/phone) go to UI_SHOTS for the test report.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const SHOTS = process.env.UI_SHOTS ?? "test-results/ui-shell/screenshots";
const OUT = process.env.UI_OUT ?? "test-results/ui-shell";
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(email);
}

const MEMBER_PAGES = [
  { path: "/", name: "Dashboard" },
  { path: "/contacts", name: "Contacts" },
  { path: "/contacts/issues", name: "Data issues" },
  { path: "/sync", name: "Sync" },
  { path: "/templates", name: "Emails" },
  // M5
  { path: "/campaigns", name: "Campaigns" },
  { path: "/suppressions", name: "Suppressions" },
  // M6
  { path: "/campaigns/scheduled", name: "Scheduled" },
];
const ADMIN_PAGES = [
  { path: "/settings/notion", name: "Notion settings" },
  { path: "/settings/sending", name: "Sending" },
  { path: "/staff", name: "Staff & audit" },
];

/** Collect console errors and page errors for one page visit. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test.describe("R-UI-01 / R-UI-06: every page renders; navigation by role", () => {
  test("admin: all pages render without console errors; nav marks the current page", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, "admin@example.com");
    for (const p of [...MEMBER_PAGES, ...ADMIN_PAGES]) {
      const res = await page.goto(p.path);
      expect(res?.status(), p.path).toBe(200);
      await expect(page.locator("main#main")).toBeVisible();
      const current = page.locator('[data-testid="sidebar-nav"] a[aria-current="page"]');
      await expect(current, p.path).toHaveCount(1);
      await expect(current).toHaveText(p.name);
    }
    expect(errors).toEqual([]);
    // Internal tools are never linked from the app chrome.
    await expect(page.locator('a[href^="/internal"]')).toHaveCount(0);
  });

  test("member: admin items are hidden and admin pages are refused", async ({ page }) => {
    await signIn(page, "member@example.com");
    const nav = page.getByTestId("sidebar-nav");
    for (const p of MEMBER_PAGES) await expect(nav.getByRole("link", { name: p.name, exact: true })).toBeVisible();
    for (const p of ADMIN_PAGES) await expect(nav.getByRole("link", { name: p.name, exact: true })).toHaveCount(0);
    await page.goto("/settings/sending");
    await expect(page.getByTestId("forbidden")).toBeVisible();
  });
});

test("R-UI-02: keyboard — skip link first, visible focus, nav reachable", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/contacts");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Bỏ qua tới nội dung" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  // Tab to a nav link and check it shows a focus outline.
  await page.goto("/");
  let found = false;
  for (let i = 0; i < 12 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => document.activeElement?.closest('[data-testid="sidebar-nav"]') !== null);
  }
  expect(found).toBe(true);
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
});

for (const width of [375, 768, 1024, 1440]) {
  test(`R-UI-03: no horizontal page scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, "admin@example.com");
    // Check every page first, then fail with the full list (one failure must not hide others).
    const overflow: string[] = [];
    for (const p of [...MEMBER_PAGES, ...ADMIN_PAGES]) {
      await page.goto(p.path);
      const r = await page.evaluate(() => {
        const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        if (over <= 0) return null;
        const vw = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll("main *")]
          .filter((el) => el.getBoundingClientRect().right > vw + 1 && !el.closest(".table-wrap, .frame-wrap"))
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className || ""}`);
        return { over, wide };
      });
      if (r) overflow.push(`${p.path}: +${r.over}px (${r.wide.join(", ")})`);
    }
    expect(overflow, `pages wider than ${width}px`).toEqual([]);
    if (width === 375) {
      // Phone: the sidebar is a drawer behind the menu button.
      await page.goto("/");
      await expect(page.getByTestId("sidebar-nav")).toBeHidden();
      await page.getByTestId("menu-toggle").click();
      await expect(page.getByTestId("sidebar-nav")).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, "phone-375-drawer-open.png") });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sidebar-nav")).toBeHidden();
      await page.goto("/templates");
      await page.screenshot({ path: path.join(SHOTS, "phone-375-emails.png"), fullPage: true });
    }
  });
}

test("R-UI-04: axe finds no serious or critical violations, light and dark", async ({ page }) => {
  await signIn(page, "admin@example.com");
  const report: Record<string, unknown> = {};
  const serious: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const p of [...MEMBER_PAGES, ...ADMIN_PAGES]) {
      await page.goto(p.path);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      report[`${scheme} ${p.path}`] = r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
      for (const v of bad) serious.push(`${scheme} ${p.path} — ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
    }
    await page.goto("/");
    await page.screenshot({ path: path.join(SHOTS, `dashboard-${scheme}.png`), fullPage: true });
    await page.goto("/contacts");
    await page.screenshot({ path: path.join(SHOTS, `contacts-${scheme}.png`), fullPage: true });
  }
  fs.writeFileSync(path.join(OUT, "axe-summary.json"), JSON.stringify(report, null, 2));
  expect(serious, "serious/critical axe violations").toEqual([]);
});

test("R-UI-03/04 (detail pages): email editor and contact detail — axe light/dark and no page scroll at 375px", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/templates");
  await page.getByTestId("import-html").fill('<!DOCTYPE html><html><head><title>UI check (SYNTHETIC)</title></head><body><table role="presentation" width="600"><tr><td><h1>Tiêu đề</h1><p>Chào {{ greeting_name | default: "bạn" }}</p><a href="https://example.com/x">Link</a></td></tr></table></body></html>');
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  const editorUrl = page.url();
  await page.goto("/contacts");
  const first = page.getByTestId("contact-row").first().getByRole("link").first();
  const contactUrl = (await first.count()) ? new URL((await first.getAttribute("href"))!, editorUrl).toString() : null;
  const targets = [editorUrl, ...(contactUrl ? [contactUrl] : [])];
  const problems: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const u of targets) {
      await page.goto(u);
      // The email itself (inside the sandboxed iframe) is the user's content, not app chrome.
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude('[data-testid="preview-frame"]').analyze();
      for (const v of r.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) problems.push(`${scheme} ${new URL(u).pathname} — ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 375, height: 900 });
  for (const u of targets) {
    await page.goto(u);
    const r = await page.evaluate(() => {
      const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const vw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll("main *")]
        .filter((el) => el.getBoundingClientRect().right > vw + 1 && !el.closest(".table-wrap") && !el.parentElement?.closest(".frame-wrap"))
        .slice(0, 4)
        .map((el) => `${el.tagName.toLowerCase()}[${(el as HTMLElement).dataset.testid ?? (el as HTMLElement).className}]`);
      return { over, wide };
    });
    if (r.over > 0) problems.push(`375px ${new URL(u).pathname}: +${r.over}px (${r.wide.join(", ")})`);
  }
  await page.goto(editorUrl);
  await page.screenshot({ path: path.join(SHOTS, "phone-375-editor.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(editorUrl);
  // Defects found by screenshot review (M4 QA): the drawer button must be hidden on desktop, and
  // the single-line subject input must not be stretched vertically.
  await expect(page.getByTestId("menu-toggle")).toBeHidden();
  const subjectHeight = (await page.getByTestId("subject-input").boundingBox())?.height ?? 999;
  expect(subjectHeight).toBeLessThan(60);
  await page.screenshot({ path: path.join(SHOTS, "editor-1440.png"), fullPage: true });
  expect(problems).toEqual([]);
});

test("R-UI-04b: the signed-out sign-in page passes axe", async ({ page }) => {
  await page.goto("/sign-in");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: path.join(SHOTS, "sign-in.png") });
});

test("R-UI-05: prefers-reduced-motion disables transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page, "admin@example.com");
  const d = await page.locator(".nav-item").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(d.split(",").every((x) => parseFloat(x) === 0)).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  const d2 = await page.locator(".nav-item").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(d2.split(",").some((x) => parseFloat(x) > 0)).toBe(true);
});

test("theme toggle persists across reloads (cookie, server-rendered)", async ({ page }) => {
  await signIn(page, "admin@example.com");
  const t = page.getByTestId("theme-toggle");
  await expect(t).toHaveAttribute("data-theme-value", "system");
  await t.click(); // → light
  await t.click(); // → dark
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-toggle").click(); // → system
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});
