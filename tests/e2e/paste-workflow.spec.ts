/**
 * M3 rev 2 — the user's primary workflow, through the UI, in Chromium (MOCK environment; nothing
 * is sent):  Paste HTML → Import → Preview → Edit text / image / link → Save → Reopen → Export.
 *
 * Input: the labelled INTERNAL fixture fixtures/email-templates/internal-paste-workflow.html,
 * pasted through the real clipboard into the Paste HTML box (no file upload, no CSS selector).
 * Browser validation only — NOT Gmail, Outlook or mobile mail apps.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { stripAnnotations } from "../../src/lib/templates/editable";
import { countConditionalComments } from "../../src/lib/templates/html-doc";
import { scanMergeFields } from "../../src/lib/templates/merge";
import { sanitizeEmailHtml } from "../../src/lib/templates/sanitize";

const FIXTURE = fs.readFileSync("fixtures/email-templates/internal-paste-workflow.html", "utf8");
// What Export returns for v1: the stored (sanitized) HTML, serialized by the export route.
const V1 = stripAnnotations(sanitizeEmailHtml(FIXTURE).html);
// M4: screenshots no longer overwrite the committed M3 rev 2 evidence; a test cycle chooses its folder.
const SHOTS = process.env.PASTE_WORKFLOW_SHOTS ?? "test-results/paste-workflow/screenshots";
const OUT = "test-results/paste-workflow";
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const MERGE = '{{ greeting_name | default: "Quý khách" }}';

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function signIn(page: Page, email = "admin@example.com") {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText(email);
}

/** Put HTML on the real clipboard and paste it into the Paste HTML box, then Import. */
async function pasteAndImport(page: Page, html: string, shot?: string) {
  await page.goto("/templates");
  const box = page.getByTestId("import-html");
  await expect(box).toBeVisible();
  await expect(page.getByTestId("import-extract")).toBeHidden(); // no selector needed
  await page.evaluate((t) => navigator.clipboard.writeText(t), html);
  await box.click();
  await page.keyboard.press("Control+V");
  await expect(box).toHaveValue(html);
  if (shot) await page.screenshot({ path: path.join(SHOTS, shot), fullPage: true });
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  return page.url().split("/templates/")[1].split("?")[0];
}

const frameOf = (page: Page) => page.frameLocator('[data-testid="preview-frame"]');
const exportOf = async (page: Page, id: string, q = "") => (await page.request.get(`/templates/${id}/export${q}`)).text();

test("main UI: Paste HTML is the entry point; no fixture gallery or GrapesJS controls", async ({ page }) => {
  await signIn(page);
  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Paste HTML" })).toBeVisible();
  await expect(page.getByTestId("import-html")).toBeVisible();
  await expect(page.getByTestId("import-submit")).toHaveText("Import");
  await expect(page.locator('[data-testid^="fixture-"]')).toHaveCount(0);
  await expect(page.locator(".paste-card").getByText(/GrapesJS|synthetic|TỔNG HỢP|fixture/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Import TỔNG HỢP|Import INTERNAL/ })).toHaveCount(0);
  await expect(page.getByTestId("import-file")).toBeHidden(); // optional, under "More import options"
  await page.screenshot({ path: path.join(SHOTS, "01-emails-page.png"), fullPage: true });
});

test("paste → import → preview → edit text, image and link → save → reopen → export", async ({ page }) => {
  await signIn(page);
  const id = await pasteAndImport(page, FIXTURE, "02-pasted.png");
  const frame = frameOf(page);
  const metrics: Record<string, unknown> = {};

  // Import: stored exactly as the sanitizer output of the pasted HTML (no selector, whole document).
  const v1 = await exportOf(page, id);
  expect(v1).toBe(V1);
  expect(v1).not.toContain("&nbsp;");
  await expect(page.getByTestId("template-title")).toHaveText("INTERNAL FIXTURE – Paste workflow");
  await expect(page.locator('[data-testid="open-grapesjs"]')).toHaveCount(0);

  // Preview.
  await expect(frame.locator("h1")).toHaveText("Bản tin tháng 11");
  await expect(frame.locator("p").first()).toContainText("GIẢM 30%");
  await expect(page.getByTestId("broken-images")).toContainText("All images loaded");

  // Text 1 — the heading: replace its text in the preview and insert a merge field at the cursor.
  await frame.locator("h1").click();
  await expect(page.getByTestId("region-form")).toHaveAttribute("data-region", /^t/);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Ưu đãi tháng 11 cho ");
  await page.getByTestId("insert-merge").selectOption("greeting_name");
  await expect(page.getByTestId("format-status")).toHaveAttribute("data-state", "text-only");

  // Text 2 — the paragraph with a coloured <span>, a <font> and a merge field: append a sentence.
  await frame.locator("p").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Cảm ơn!");
  await expect(page.getByTestId("format-status")).toHaveAttribute("data-state", "text-only");
  await expect(page.getByTestId("format-status")).toContainText("All formatting is kept");
  await page.screenshot({ path: path.join(SHOTS, "03-text-edited-formatting-kept.png"), fullPage: true });

  // Image.
  await frame.locator('img[alt="Ảnh chương trình"]').click();
  await expect(page.getByTestId("region-form")).toHaveAttribute("data-region", /^i/);
  await page.getByTestId("edit-src").fill("/fixtures/email/hero-alt.png");
  await page.getByTestId("edit-alt").fill("Ảnh chương trình tháng 11");

  // Link inside a text block: click it in the preview.
  await frame.locator("a", { hasText: "chi tiết ưu đãi" }).click();
  await expect(page.getByTestId("region-form")).toHaveAttribute("data-region", /^l/);
  await page.getByTestId("edit-href").fill("https://anphat.example/uu-dai-thang-11");

  await expect(page.getByTestId("save-version")).toHaveText("Save as new version (4 changes)");
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
  await expect(page.getByTestId("version-note-2")).toContainText("text (all formatting kept)");

  // Reopen from the list (fresh navigation): the latest version opens with the edits.
  await page.goto("/templates");
  await page.getByTestId("open-email").filter({ hasText: "INTERNAL FIXTURE – Paste workflow" }).first().click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
  await expect(frame.locator("h1")).toHaveText(`Ưu đãi tháng 11 cho ${MERGE}`);
  await page.getByTestId("preview-mode").selectOption("sample-full");
  await expect(frame.locator("h1")).toHaveText("Ưu đãi tháng 11 cho Anh An");
  await page.getByTestId("preview-mode").selectOption("sample-no-greeting");
  await expect(frame.locator("h1")).toHaveText("Ưu đãi tháng 11 cho Quý khách");
  await expect(frame.locator("p").first()).toContainText("Kính gửi Quý khách");
  await page.screenshot({ path: path.join(SHOTS, "04-reopened-recipient-preview.png"), fullPage: true });

  // The original stays available.
  await page.getByTestId("versions-panel").getByRole("link", { name: "v1", exact: true }).click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  await expect(frame.locator("h1")).toHaveText("Bản tin tháng 11");

  // Export: v2 is v1 with ONLY the four edits. Every other byte (styles, the <span>, the <font>,
  // MSO comments, VML, merge fields, &amp;) is identical.
  const v2 = await exportOf(page, id);
  metrics.nbspInsertedByBrowserTyping = (v2.match(/&nbsp;/g) ?? []).length;
  const expected = V1.replace(">Bản tin tháng 11</h1>", `>Ưu đãi tháng 11 cho ${MERGE}</h1>`)
    .replace("Hãy đăng ký sớm.</p>", "Hãy đăng ký sớm. Cảm ơn!</p>")
    .replace('src="/fixtures/email/hero.png"', 'src="/fixtures/email/hero-alt.png"')
    .replace('alt="Ảnh chương trình"', 'alt="Ảnh chương trình tháng 11"')
    .replace('href="https://anphat.example/uu-dai"', 'href="https://anphat.example/uu-dai-thang-11"');
  expect(v2.split("&nbsp;").join(" ")).toBe(expected);
  expect(countConditionalComments(v2)).toBe(countConditionalComments(V1));
  const raws = (h: string) => scanMergeFields(h).uses.map((u) => u.raw).sort();
  expect(raws(v2)).toEqual([...raws(V1), MERGE].sort());
  expect(v2).toContain('<span style="color:#c0392b;font-weight:bold">GIẢM 30%</span>');
  expect(v2).toContain('<font color="#1f5f8b" face="Georgia">khách hàng thân thiết</font>');
  expect(v2).not.toContain("data-emt-id");
  expect(v2).not.toContain("contenteditable");
  const txt = await exportOf(page, id, "?format=txt");
  expect(txt).toContain("Cảm ơn!");
  expect(txt).toContain(MERGE);
  metrics.v1Bytes = Buffer.byteLength(v1);
  metrics.v2Bytes = Buffer.byteLength(v2);
  metrics.exactlyFourTargetedChanges = true;
  fs.writeFileSync(path.join(OUT, "main-flow.json"), JSON.stringify(metrics, null, 2));
});

test("formatting loss needs a choice: undo, keep, or HTML source (sanitized on save)", async ({ page }) => {
  await signIn(page);
  const id = await pasteAndImport(page, FIXTURE);
  const frame = frameOf(page);
  const para = frame.locator("p").first();

  // Replacing everything in the block removes the <span> and <font>: the editor must stop and ask.
  await para.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Nội dung mới, không còn định dạng.");
  const status = page.getByTestId("format-status");
  await expect(status).toHaveAttribute("data-state", "loss");
  await expect(status).toContainText('<span style="color:#c0392b;font-weight:bold"> around “GIẢM 30%”');
  await expect(status).toContainText('<font color="#1f5f8b" face="Georgia">');
  await expect(page.getByTestId("save-version")).toBeDisabled();
  await expect(page.getByTestId("save-blocked")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "05-formatting-loss-choice.png"), fullPage: true });

  // Undo restores the block exactly.
  await page.getByTestId("loss-actions").getByTestId("undo-block").click();
  await expect(para).toContainText("GIẢM 30%");
  await expect(para.locator('span[style*="c0392b"]')).toHaveCount(1);
  await expect(page.getByTestId("format-status")).toHaveCount(0);
  await expect(page.getByTestId("save-version")).toBeDisabled(); // nothing to save

  // Keep: an explicit choice; the save records what was removed.
  await para.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Nội dung mới, không còn định dạng.");
  await page.getByTestId("keep-format-change").click();
  await expect(status).toHaveAttribute("data-state", "accepted");
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
  await expect(page.getByTestId("version-note-2")).toContainText("formatting removed (accepted)");
  const v2 = await exportOf(page, id);
  expect(v2).toContain(">Nội dung mới, không còn định dạng.</p>");
  expect(v2).toContain('Xem <a href="https://anphat.example/uu-dai"'); // other blocks untouched

  // HTML source: precise control; unsafe markup is removed on save.
  await frame.locator("p").nth(1).click();
  await page.getByTestId("mode-source").click();
  await page
    .getByTestId("edit-source")
    .fill('Xem <a href="https://anphat.example/uu-dai" style="color:#c0392b">chi tiết</a> <strong>mới</strong> <img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>');
  await expect(frameOf(page).locator("p").nth(1)).toContainText("chi tiết mới");
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 3");
  const v3 = await exportOf(page, id);
  expect(v3).toContain('Xem <a href="https://anphat.example/uu-dai" style="color:#c0392b">chi tiết</a> <strong>mới</strong>');
  expect(v3).not.toMatch(/<script|onerror|javascript:|<img src="?x/i);
  await expect(page.getByTestId("sanitize-panel")).toBeVisible();
});

test("formatting toolbar is an explicit conversion with a preview of what it removes, and undo", async ({ page }) => {
  await signIn(page);
  await pasteAndImport(page, FIXTURE);
  const frame = frameOf(page);
  await frame.locator("p").first().click();
  await page.getByTestId("mode-rich").click();
  const confirm = page.getByTestId("convert-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('<span style="color:#c0392b;font-weight:bold">');
  await expect(confirm).toContainText('<font color="#1f5f8b" face="Georgia">');
  await page.screenshot({ path: path.join(SHOTS, "06-toolbar-conversion-preview.png"), fullPage: true });
  await page.getByTestId("convert-no").click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("edit-text")).toHaveCount(0);

  await page.getByTestId("mode-rich").click();
  await page.getByTestId("convert-yes").click();
  const pm = page.getByTestId("edit-text").locator(".ProseMirror");
  await pm.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Thêm");
  await expect(page.getByTestId("format-status")).toHaveAttribute("data-state", "accepted");
  await page.getByTestId("undo-block").click();
  await expect(frame.locator("p").first().locator('span[style*="c0392b"]')).toHaveCount(1);
  await expect(frame.locator("p").first().locator("font")).toHaveCount(1);
  await expect(page.getByTestId("save-version")).toBeDisabled();
});

test("a pasted fragment (no <html>/<body>) and a typed-markup attempt", async ({ page }) => {
  await signIn(page);
  const frag = '<table role="presentation"><tr><td style="font-family:Arial"><p style="color:#333">Xin chào <b style="color:#c00">{{ full_name | default: "bạn" }}</b>, cảm ơn bạn.</p></td></tr></table>';
  const id = await pasteAndImport(page, frag);
  const frame = frameOf(page);
  await expect(frame.locator("p")).toContainText('Xin chào {{ full_name | default: "bạn" }}');
  await frame.locator("p").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" <b>không phải thẻ</b>");
  await expect(page.getByTestId("format-status")).toHaveAttribute("data-state", "text-only");
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 2");
  const v2 = await exportOf(page, id);
  expect(v2).toContain('<b style="color:#c00">{{ full_name | default: "bạn" }}</b>, cảm ơn bạn. &lt;b&gt;không phải thẻ&lt;/b&gt;</p>');
});

test("internal tools are separate: members cannot open the lab", async ({ page }) => {
  await signIn(page, "member@example.com");
  await page.goto("/internal/editor-lab");
  await expect(page).toHaveURL(/forbidden$/);
});

test("internal tools are separate: admin-only lab, not linked from the product UI", async ({ page }) => {
  await signIn(page);
  await expect(page.locator('header a[href^="/internal"]')).toHaveCount(0);
  await page.goto("/internal/editor-lab");
  await expect(page.getByTestId("lab-banner")).toContainText("Internal test tooling");
});
