/**
 * M3 editor trial, end to end in Chromium (MOCK environment, no email is sent).
 *
 * For each input — SYNTHETIC fixtures A and B, and the real-template CANDIDATE if present on this
 * machine (.local/real-templates/, git-ignored) — it imports, edits text/image/button/link in the
 * structure-preserving editor, saves, reopens, exports, checks merge fields and recipient
 * fallbacks, captures desktop/mobile browser renderings, and measures GrapesJS on the same input.
 *
 * Results (counts/metrics only) are written to test-results/editor-trial/*.json for the report.
 * IMPORTANT: renderings are Chromium only — NOT Gmail, Outlook or mobile mail apps.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { countConditionalComments } from "../../src/lib/templates/html-doc";
import { scanMergeFields } from "../../src/lib/templates/merge";
import { extractFragment } from "../../src/lib/templates/sanitize";

const OUT = "test-results/editor-trial";
fs.mkdirSync(OUT, { recursive: true });
// Real templates are optional, local-only and git-ignored. Absent → only synthetic inputs run.
const REAL_DIR = ".local/real-templates";
const REAL = fs.existsSync(REAL_DIR)
  ? fs
      .readdirSync(REAL_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".html"))
      .map((d) => path.join(REAL_DIR, d.name))
  : [];

type Input = { key: string; label: string; kind: "fixture" | "real"; fixture?: string; file?: string; extract?: string };
const INPUTS: Input[] = [
  { key: "synthetic-a", label: "SYNTHETIC A", kind: "fixture", fixture: "synthetic-a" },
  { key: "synthetic-b", label: "SYNTHETIC B", kind: "fixture", fixture: "synthetic-b" },
  ...REAL.map((f, i) => ({ key: `real-${i + 1}`, label: `REAL CANDIDATE ${i + 1}`, kind: "real" as const, file: f, extract: "#email" })),
];

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByTestId("dev-email").fill("admin@example.com");
  await page.getByTestId("dev-sign-in").click();
  await expect(page.getByTestId("current-user")).toContainText("admin@example.com");
}

async function shot(browser: Browser, url: string | null, html: string | null, width: number, file: string, cookies: Parameters<import("@playwright/test").BrowserContext["addCookies"]>[0]) {
  // JavaScript disabled: raw inputs may contain scripts; we measure rendering only.
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: false, baseURL: process.env.E2E_BASE_URL });
  await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  if (url) await p.goto(url);
  else await p.setContent(html!.replace(/<head>/i, `<head><base href="${process.env.E2E_BASE_URL}/">`), { waitUntil: "load" });
  await p.waitForTimeout(150);
  const buf = await p.screenshot({ fullPage: true });
  fs.writeFileSync(file, buf);
  await ctx.close();
  return PNG.sync.read(buf);
}

function pixelDiff(a: PNG, b: PNG) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (p: PNG) => {
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(p, out, 0, 0, w, h, 0, 0);
    return out;
  };
  const changed = pixelmatch(crop(a).data, crop(b).data, null, w, h, { threshold: 0.1 });
  return { changedPixels: changed, ratio: +(changed / (w * h)).toFixed(4), heightA: a.height, heightB: b.height };
}

const mergeRaws = (html: string) => scanMergeFields(html).uses.map((u) => u.raw).sort();

for (const input of INPUTS) {
  test.describe.serial(`${input.label}`, () => {
    let templateId = "";
    let v1 = "";
    let v1Html = "";
    const metrics: Record<string, unknown> = { input: input.key, kind: input.kind };
    const dir = path.join(OUT, input.key);
    fs.mkdirSync(dir, { recursive: true });

    test.afterAll(() => fs.writeFileSync(path.join(OUT, `${input.key}.json`), JSON.stringify(metrics, null, 2)));

    test("import, sanitize report, regions, checks", async ({ page }) => {
      await signIn(page);
      await page.goto("/templates");
      if (input.kind === "fixture") {
        await page.getByTestId(`fixture-${input.fixture}`).click();
      } else {
        await page.getByTestId("import-name").fill(`${input.label} (local file)`);
        await page.getByTestId("import-file").setInputFiles(input.file!);
        await page.getByTestId("import-extract").fill(input.extract ?? "");
        await page.getByTestId("import-submit").click();
      }
      await expect(page.getByTestId("version-info")).toContainText("Version 1");
      templateId = page.url().split("/templates/")[1].split("?")[0];
      const resp = await page.request.get(`/templates/${templateId}/export`);
      v1Html = await resp.text();
      v1 = (await page.getByTestId("versions-panel").getByRole("link", { name: "v1", exact: true }).getAttribute("href"))!.split("v=")[1];
      metrics.regions = await page.locator('[data-testid^="region-"]').count();
      metrics.sanitize = (await page.getByTestId("sanitize-panel").innerText()).split("\n").slice(1);
      metrics.findings = (await page.getByTestId("lint-panel").locator("li").allInnerTexts()).map((t) => t.split("\n")[0]);
      metrics.mergeFieldsV1 = mergeRaws(v1Html);
      metrics.msoMarkersV1 = countConditionalComments(v1Html);
      metrics.bytesV1 = Buffer.byteLength(v1Html);
      expect(v1Html).not.toMatch(/<script|onerror=|onclick=|javascript:/i);
      expect(v1Html).not.toContain("data-emt-id");
      if (input.kind === "fixture") await page.screenshot({ path: path.join(dir, "editor-v1.png"), fullPage: true });
    });

    test("edit text, image, button and link; save; reopen; export", async ({ page }) => {
      await signIn(page);
      await page.goto(`/templates/${templateId}`);
      const edits: string[] = [];
      const regions = page.locator('[data-testid^="region-"]');
      const pick = async (kind: string) => {
        const r = regions.filter({ hasText: new RegExp(`^${kind}\\b`) }).first();
        if (!(await r.count())) return false;
        await r.click();
        await expect(page.getByTestId("region-form")).toBeVisible();
        return true;
      };

      // Text: append a sentence that contains a merge field (inserted via the picker).
      // Fixture A: the greeting paragraph, which also contains a coloured <span> the rich-text
      // editor cannot keep — the warning must be shown and the loss is measured below.
      const textRegion = regions.filter({ hasText: /^text\b/ }).nth(input.key === "synthetic-a" ? 2 : 0);
      await textRegion.click();
      metrics.unsupportedInlineWarning = (await page.getByTestId("unsupported-inline").count()) ? await page.getByTestId("unsupported-inline").innerText() : null;
      if (input.key === "synthetic-a") expect(metrics.unsupportedInlineWarning).toMatch(/inline style on <span>/);
      const pm = page.getByTestId("edit-text").locator(".ProseMirror");
      await pm.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" Xin cảm ơn ");
      await page.getByTestId("insert-merge").selectOption("greeting_name");
      await page.keyboard.type("!");
      edits.push("text");

      if (await pick("image")) {
        await page.getByTestId("edit-src").fill("/fixtures/email/hero-alt.png");
        await page.getByTestId("edit-alt").fill("Ảnh đã đổi trong thử nghiệm");
        edits.push("image");
      }
      if (await pick("button")) {
        await page.getByTestId("edit-button-text").fill("Mua ngay");
        await page.getByTestId("edit-href").fill("https://anphat.example/mua?ma={{ email | url_encode }}");
        edits.push("button");
      }
      if (await pick("link")) {
        await page.getByTestId("edit-href").fill("https://example.com/da-doi-lien-ket");
        edits.push("link");
      }
      metrics.editsMade = edits;
      // Both synthetic fixtures contain a CTA button; failing to detect it is a defect (M3 F-finding).
      if (input.kind === "fixture") expect(edits).toEqual(expect.arrayContaining(["text", "image", "button", "link"]));
      await page.getByTestId("save-version").click();
      await expect(page.getByTestId("version-info")).toContainText("Version 2");

      // Reopen (fresh navigation) and export.
      await page.reload();
      await expect(page.getByTestId("version-info")).toContainText("Version 2");
      const v2Html = await (await page.request.get(`/templates/${templateId}/export`)).text();
      expect(v2Html).toContain("Xin cảm ơn");
      expect(v2Html).toContain('{{ greeting_name | default: "Quý khách" }}!');
      if (edits.includes("image")) expect(v2Html).toContain('src="/fixtures/email/hero-alt.png"');
      if (edits.includes("button")) {
        expect(v2Html).toContain(">Mua ngay</a>");
        expect(v2Html).toContain('href="https://anphat.example/mua?ma={{ email | url_encode }}"');
      }
      if (edits.includes("link")) expect(v2Html).toContain('href="https://example.com/da-doi-lien-ket"');
      expect(v2Html).not.toContain("data-emt-id");
      // Merge fields survive: every v1 field is still present (plus the one we added).
      const v2Merge = mergeRaws(v2Html);
      for (const m of new Set(metrics.mergeFieldsV1 as string[])) expect(v2Merge).toContain(m);
      expect(countConditionalComments(v2Html)).toBe(metrics.msoMarkersV1);
      metrics.mergeFieldsV2 = v2Merge;
      metrics.inlineStyledSpansV1 = (v1Html.match(/<span[^>]*style=/gi) ?? []).length;
      metrics.inlineStyledSpansV2 = (v2Html.match(/<span[^>]*style=/gi) ?? []).length;
      metrics.msoMarkersV2 = countConditionalComments(v2Html);
      metrics.bytesV2 = Buffer.byteLength(v2Html);
      const txt = await (await page.request.get(`/templates/${templateId}/export?format=txt`)).text();
      metrics.plainTextChars = txt.length;
      expect(txt).toContain("Xin cảm ơn");
    });

    test("recipient previews and missing-name fallbacks", async ({ page }) => {
      await signIn(page);
      await page.goto(`/templates/${templateId}`);
      const frame = page.frameLocator('[data-testid="preview-frame"]');
      await page.getByTestId("preview-mode").selectOption("sample-full");
      await expect(frame.locator("body")).toContainText("Anh An!");
      await page.getByTestId("preview-mode").selectOption("sample-no-greeting");
      await expect(frame.locator("body")).toContainText("Quý khách!");
      await expect(page.getByTestId("missing-fallback")).toBeVisible();
      metrics.missingWithoutFallback_noGreeting = await page.getByTestId("missing-fallback").innerText();
      await page.getByTestId("preview-mode").selectOption("sample-no-company");
      metrics.missingWithoutFallback_noCompany = await page.getByTestId("missing-fallback").innerText();
      metrics.brokenImagesInBrowserPreview = await page.getByTestId("broken-images").innerText();
      if (input.key === "synthetic-a") {
        await expect(frame.locator("body")).toContainText("quý công ty");
        await page.screenshot({ path: path.join(dir, "preview-recipient-no-company.png"), fullPage: true });
      }
    });

    test("responsive browser renderings and import fidelity (Chromium only)", async ({ page, browser, context }) => {
      await signIn(page);
      const cookies = await context.cookies();
      // Real candidate: the "#email" part of the supplied page, before sanitization.
      const raw =
        input.kind === "fixture"
          ? fs.readFileSync(`fixtures/email-templates/${input.key === "synthetic-a" ? "synthetic-a-newsletter" : "synthetic-b-promo-hazards"}.html`, "utf8")
          : extractFragment(fs.readFileSync(input.file!, "utf8"), input.extract ?? "body").html;
      const out: Record<string, unknown> = {};
      for (const width of [640, 375]) {
        const v1Png = await shot(browser, `/templates/${templateId}/preview?v=${v1}&mode=recipient&r=sample-full`, null, width, path.join(dir, `v1-${width}.png`), cookies);
        const latest = await shot(browser, `/templates/${templateId}/preview?mode=recipient&r=sample-full`, null, width, path.join(dir, `v2-${width}.png`), cookies);
        out[`v1_vs_v2_${width}`] = pixelDiff(v1Png, latest);
        if (raw) {
          // The raw file is rendered with JavaScript off and its meta refresh removed (fixture B
          // would otherwise navigate away); everything else is as supplied.
          const rawRenderable = raw.replace(/<meta[^>]+http-equiv=["']?refresh[^>]*>/gi, "");
          const rawPng = await shot(browser, null, rawRenderable, width, path.join(dir, `raw-${width}.png`), cookies);
          out[`raw_vs_v1_${width}`] = pixelDiff(rawPng, await shot(browser, null, v1Html, width, path.join(dir, `v1-raw-merge-${width}.png`), cookies));
        }
      }
      metrics.rendering = out;
    });

    test("GrapesJS (candidate b): no-edit export fidelity, then an edit + save", async ({ page, browser, context }) => {
      test.setTimeout(120_000);
      await signIn(page);
      await page.goto(`/templates/${templateId}/grapesjs?v=${v1}`);
      await page.waitForFunction(() => window.__gjs?.ready === true, null, { timeout: 60_000 });
      const exported = await page.evaluate(() => window.__gjs!.exportHtml());
      fs.writeFileSync(path.join(dir, "grapesjs-noedit-export.html.txt"), input.kind === "fixture" ? exported : "(real template content not stored)");
      const g: Record<string, unknown> = {
        bytes: Buffer.byteLength(exported),
        msoMarkers: countConditionalComments(exported),
        msoMarkersExpected: metrics.msoMarkersV1,
        vmlPresent: /<v:roundrect/i.test(exported),
        vmlExpected: /<v:roundrect/i.test(v1Html),
        mergeFieldsSame: JSON.stringify(mergeRaws(exported)) === JSON.stringify(metrics.mergeFieldsV1),
        mergeFieldsExported: mergeRaws(exported),
        bodyStyleTagsInBody: (exported.split(/<body/i)[1]?.match(/<style/gi) ?? []).length,
        idAttributesAdded: (exported.match(/\sid="i[a-z0-9]{3,}"/gi) ?? []).length,
        classAttributes: (exported.match(/\sclass="/gi) ?? []).length,
        classAttributesV1: (v1Html.match(/\sclass="/gi) ?? []).length,
        roleAttributes: (exported.match(/role="presentation"/gi) ?? []).length,
        roleAttributesV1: (v1Html.match(/role="presentation"/gi) ?? []).length,
      };
      const cookies = await context.cookies();
      const render: Record<string, unknown> = {};
      for (const width of [640, 375]) {
        const a = await shot(browser, null, v1Html, width, path.join(dir, `gjs-base-${width}.png`), cookies);
        const b = await shot(browser, null, exported, width, path.join(dir, `gjs-noedit-${width}.png`), cookies);
        render[`v1_vs_grapesjs_noedit_${width}`] = pixelDiff(a, b);
      }
      g.rendering = render;
      // Edit the first text component through the GrapesJS API, then save via the UI button.
      await page.evaluate(() => {
        const ed = window.__gjs!.editor;
        const txt = ed.getWrapper()!.find("[data-gjs-type=text], td, p").find((c) => (c.toHTML?.() ?? "").length < 4000 && /\w/.test(c.getInnerHTML?.() ?? ""));
        txt?.components(`${txt.getInnerHTML()} (sửa bằng GrapesJS)`);
      });
      await page.getByTestId("gjs-save").click();
      await expect(page).toHaveURL(new RegExp(`/templates/${templateId}\\?v=`), { timeout: 30_000 });
      await expect(page.getByTestId("version-info")).toContainText("grapesjs");
      const saved = await (await page.request.get(`/templates/${templateId}/export`)).text();
      g.savedContainsEdit = saved.includes("(sửa bằng GrapesJS)");
      g.savedMergeFields = mergeRaws(saved);
      g.savedMsoMarkers = countConditionalComments(saved);
      metrics.grapesjs = g;
    });
  });
}

test("TipTap paste (candidate c): formatted text from a Google-Docs-like clipboard keeps bold/italic/links, drops styles", async ({ page }) => {
  await signIn(page);
  await page.goto("/templates");
  await page.getByTestId("fixture-synthetic-a").click();
  await expect(page.getByTestId("version-info")).toContainText("Version 1");
  await page.locator('[data-testid^="region-"]').filter({ hasText: /^text\b/ }).nth(2).click();
  const pm = page.getByTestId("edit-text").locator(".ProseMirror");
  await pm.click();
  await page.keyboard.press("Control+A");
  // SYNTHETIC clipboard payload modelled on Google Docs HTML (bold/italic as styled spans).
  const clip =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-synthetic"><p dir="ltr" style="line-height:1.38;margin-top:0pt"><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;">Đậm từ Docs</span><span style="font-size:11pt;font-family:Arial;color:#000000;font-style:italic;"> và nghiêng</span><span style="font-size:11pt;color:#ff0000;"> chữ đỏ </span><a href="https://docs.example/x" style="text-decoration:none;"><span style="color:#1155cc;text-decoration:underline;">liên kết</span></a></p></b>';
  await pm.evaluate((el, html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", "Đậm từ Docs và nghiêng chữ đỏ liên kết");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, clip);
  const result = await pm.innerHTML();
  const metrics = {
    resultHtml: result,
    keptBold: /<strong>Đậm từ Docs<\/strong>/.test(result),
    keptItalic: /<em>\s*và nghiêng<\/em>/.test(result),
    keptLink: /<a [^>]*href="https:\/\/docs\.example\/x"/.test(result),
    droppedColour: !/color/i.test(result),
    droppedFontStyles: !/font-(size|family)/i.test(result),
  };
  fs.writeFileSync(path.join(OUT, "tiptap-paste.json"), JSON.stringify(metrics, null, 2));
  expect(metrics.keptBold).toBe(true);
  expect(metrics.keptItalic).toBe(true);
  expect(metrics.keptLink).toBe(true);
  expect(metrics.droppedColour).toBe(true);
});
