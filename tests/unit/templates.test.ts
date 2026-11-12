/**
 * M3 template library: structure preservation, sanitization, merge fields, lint.
 * Uses the SYNTHETIC fixtures in fixtures/email-templates/ (no real customer content).
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdits, annotatedHtml, EditError, regionsOf, stripAnnotations } from "../../src/lib/templates/editable";
import { countConditionalComments, normalizeForCompare, parseHtml } from "../../src/lib/templates/html-doc";
import { toInlineHtml } from "../../src/lib/templates/inline";
import { lintTemplate } from "../../src/lib/templates/lint";
import { renderForRecipient, scanMergeFields } from "../../src/lib/templates/merge";
import { extractFragment, isAllowedUrl, sanitizeEmailHtml, sanitizeInline } from "../../src/lib/templates/sanitize";

const A = sanitizeEmailHtml(fs.readFileSync("fixtures/email-templates/synthetic-a-newsletter.html", "utf8")).html;
const Braw = fs.readFileSync("fixtures/email-templates/synthetic-b-promo-hazards.html", "utf8");
const B = sanitizeEmailHtml(Braw).html;

describe("structure-preserving parse/serialize", () => {
  it.each([
    ["A", A],
    ["B", B],
  ])("fixture %s: a no-edit save is identical after normalizing only cosmetic differences", (_n, html) => {
    const out = applyEdits(html, []).html;
    expect(normalizeForCompare(out)).toBe(normalizeForCompare(html));
    // And the only raw differences are the documented cosmetic ones.
    const cosmetic = (s: string) =>
      s
        .replace(/\s*\/>/g, ">")
        .replace(/='([^']*)'/g, '="$1"')
        .replace(/ (nowrap|hidden|disabled)(?=[ >])/g, ' $1=""');
    expect(cosmetic(out)).toBe(cosmetic(html));
  });

  it("keeps MSO conditional comments, VML and merge fields through sanitize + edit", () => {
    const src = fs.readFileSync("fixtures/email-templates/synthetic-a-newsletter.html", "utf8");
    expect(countConditionalComments(A)).toBe(countConditionalComments(src));
    expect(A).toContain("<v:roundrect");
    const ops = regionsOf(A).filter((r) => r.kind === "image").slice(0, 1).map((r) => ({ id: r.id, kind: "image" as const, alt: "Logo mới" }));
    const out = applyEdits(A, ops).html;
    expect(countConditionalComments(out)).toBe(countConditionalComments(src));
    expect(scanMergeFields(out).uses.map((u) => u.raw)).toEqual(scanMergeFields(A).uses.map((u) => u.raw));
  });

  it("an edit changes only the edited element", () => {
    const regions = regionsOf(A);
    const target = regions.find((r) => r.kind === "text" && r.text?.startsWith("Ưu đãi cuối năm"))!;
    const out = applyEdits(A, [{ id: target.id, kind: "text", html: "Ưu đãi <strong>mới</strong> cho {{ company | default: \"quý công ty\" }}" }]).html;
    // Expected: the original with ONLY that element's inner HTML replaced.
    const { $ } = (() => {
      const $$ = parseHtml(annotatedHtml(A));
      $$(`[data-emt-id="${target.id}"]`).html('Ưu đãi <strong>mới</strong> cho {{ company | default: "quý công ty" }}');
      $$("[data-emt-id]").removeAttr("data-emt-id");
      return { $: $$ };
    })();
    expect(normalizeForCompare(out)).toBe(normalizeForCompare($.html()));
  });

  it("finds text, image, link and button regions in the table template", () => {
    const kinds = regionsOf(A).reduce<Record<string, number>>((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {});
    expect(kinds).toMatchObject({ image: 4, button: 1 });
    expect(kinds.text).toBeGreaterThanOrEqual(5);
    expect(regionsOf(A).find((r) => r.kind === "text" && r.hidden)?.text).toMatch(/^Ưu đãi tháng 11/); // preheader
  });

  it("edits images, links and buttons, and validates destinations", () => {
    const r = regionsOf(A);
    const img = r.find((x) => x.kind === "image")!;
    const btn = r.find((x) => x.kind === "button")!;
    const link = r.find((x) => x.kind === "link" && x.href?.startsWith("https://anphat.example/san-pham"))!;
    const out = applyEdits(A, [
      { id: img.id, kind: "image", src: "https://cdn.anphat.example/logo-2.png", alt: "Logo An Phát" },
      { id: btn.id, kind: "button", text: "Mua ngay", href: "https://anphat.example/mua?ma={{ email | url_encode }}" },
      { id: link.id, kind: "link", href: "https://anphat.example/san-pham/ap-300" },
    ]).html;
    expect(out).toContain('src="https://cdn.anphat.example/logo-2.png"');
    expect(out).toContain(">Mua ngay</a>");
    expect(out).toContain('href="https://anphat.example/mua?ma={{ email | url_encode }}"');
    expect(out).toContain("https://anphat.example/san-pham/ap-300");
    expect(out).not.toContain("data-emt-id");
    expect(() => applyEdits(A, [{ id: link.id, kind: "link", href: "javascript:alert(1)" }])).toThrow(EditError);
    expect(() => applyEdits(A, [{ id: img.id, kind: "image", src: "images/relative.png" }])).toThrow(/not allowed/);
    expect(() => applyEdits(A, [{ id: "t999", kind: "text", html: "x" }])).toThrow(/no longer exists/);
  });

  it("REGRESSION: a button that is the only content of a <p> is a button region and keeps its styling when edited", () => {
    const btn = regionsOf(B).find((r) => r.kind === "button");
    expect(btn?.href).toBe("http://shop.example/flash-sale");
    // The wrapping <p> must not be a text region (the rich-text editor would flatten the button).
    expect(regionsOf(B).some((r) => r.kind === "text" && r.text === "Mua ngay")).toBe(false);
    const out = applyEdits(B, [{ id: btn!.id, kind: "button", text: "Mua ngay hôm nay", href: "https://shop.example/flash-sale" }]).html;
    expect(out).toMatch(/<a class="cta" href="https:\/\/shop\.example\/flash-sale" style="[^"]*background:#d9480f[^"]*">Mua ngay hôm nay<\/a>/);
  });

  it("button-like links inside a text block are classified as buttons", () => {
    const r = regionsOf('<body><p>Xem thêm <a href="https://x.example" style="background-color:#000;padding:8px">Mua</a> nhé</p></body>');
    expect(r.map((x) => x.kind)).toEqual(["text", "button"]);
  });

  it("export never contains editor annotations", () => {
    expect(stripAnnotations(annotatedHtml(A))).not.toContain("data-emt-id");
    expect(annotatedHtml(A)).toContain("data-emt-id");
  });
});

describe("sanitization", () => {
  it("removes scripts, forms, iframes, objects, SVG, handlers, javascript: URLs and meta refresh from fixture B", () => {
    const { html, report } = sanitizeEmailHtml(Braw);
    for (const bad of ["<script", "<form", "<iframe", "<object", "<svg", "<input", "onerror=", "onclick=", "onload=", "javascript:", 'http-equiv="refresh"']) {
      expect(html.toLowerCase()).not.toContain(bad);
    }
    expect(report.removedElements).toMatchObject({ script: 2, iframe: 1, object: 1, form: 1, svg: 1 });
    expect(report.removedEventHandlers).toBe(3);
    expect(report.removedMetaRefresh).toBe(1);
    expect(report.cleanedStyleAttributes).toBe(1);
    expect(html).toContain("data:image/gif;base64"); // data: images are allowed (and linted)
    expect(html).toContain("⚡ Flash sale 48 giờ cho {{ full_name }}!");
  });

  it("REGRESSION: HTML between <!--[if !mso]><!--> and <!--<![endif]--> is sanitized (it is visible in non-Outlook clients)", () => {
    const evil = `<body><!--[if !mso]><!-- --><a href="https://x.example" onclick="steal()" style="color:red;background:url(javascript:alert(1))">B</a><script>x()</script><!--<![endif]--></body>`;
    const { html, report } = sanitizeEmailHtml(evil);
    expect(html).not.toMatch(/onclick|<script|javascript:/i);
    expect(html).toContain("<!--[if !mso]><!-- -->");
    expect(html).toContain("<!--<![endif]-->");
    expect(report.conditionalCommentsKept).toBe(2);
  });

  it("REGRESSION: keeps the original DOCTYPE (losing it switches rendering to quirks mode)", () => {
    expect(A.startsWith('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"')).toBe(true);
    expect(B.startsWith("<!doctype html>")).toBe(true);
    expect(applyEdits(A, []).html.startsWith("<!DOCTYPE html PUBLIC")).toBe(true);
    expect(sanitizeEmailHtml("<p>no doctype</p>").html.startsWith("<!")).toBe(false);
  });

  it("drops an Outlook-only block that contains dangerous markup, keeps safe ones", () => {
    const { html, report } = sanitizeEmailHtml(`<body><!--[if mso]><table><tr><td>ok</td></tr></table><![endif]--><!--[if mso]><script>x</script><![endif]--></body>`);
    expect(report).toMatchObject({ conditionalCommentsKept: 1, conditionalCommentsDropped: 1 });
    expect(html).toContain("<!--[if mso]><table>");
    expect(html).not.toContain("<script");
  });

  it("inline sanitizer for edited text keeps basic marks and merge fields only", () => {
    expect(sanitizeInline('Chào <strong>{{ greeting_name | default: "Quý khách" }}</strong><img src=x onerror=alert(1)><a href="javascript:x()">y</a>')).toBe(
      'Chào <strong>{{ greeting_name | default: "Quý khách" }}</strong><a>y</a>',
    );
  });

  it("URL policy", () => {
    expect(isAllowedUrl("https://a.example/x", "link")).toBe(true);
    expect(isAllowedUrl("mailto:a@example.com", "link")).toBe(true);
    expect(isAllowedUrl("{{ unsubscribe_url }}", "link")).toBe(true);
    expect(isAllowedUrl("javascript:alert(1)", "link")).toBe(false);
    expect(isAllowedUrl("http://a.example/x.png", "image")).toBe(true); // allowed but linted
    expect(isAllowedUrl("data:text/html;base64,AAA", "image")).toBe(false);
  });

  it("can import only the email part of a tool page", () => {
    const page = `<!doctype html><html lang="vi"><head><title>T</title><style>.x{color:red}</style></head><body><div id="tools"><button>Copy</button><script>copy()</script></div><div id="email"><table><tr><td>Nội dung</td></tr></table></div></body></html>`;
    const r = extractFragment(page, "#email");
    expect(r.found).toBe(true);
    expect(r.html).toContain('<div id="email">');
    expect(r.html).not.toContain("Copy");
    expect(r.html).toContain(".x{color:red}");
    expect(extractFragment(page, "#missing").found).toBe(false);
  });
});

describe("merge fields", () => {
  it("scans fields, fallbacks, contexts and problems", () => {
    const a = scanMergeFields(A).uses;
    expect(a.every((u) => !u.problem)).toBe(true);
    expect(a.find((u) => u.field === "greeting_name")).toMatchObject({ hasFallback: true, context: "text" });
    expect(a.find((u) => u.field === "email")?.context).toBe("attribute");
    const b = scanMergeFields(B).uses;
    expect(b.map((u) => u.problem).filter(Boolean)).toEqual(["unknown_field", "unknown_filter"]);
  });

  it("renders a recipient preview with fallbacks for missing names and escapes values", () => {
    const tpl = 'Kính gửi {{ greeting_name | default: "Quý khách" }}, {{ company }} <a href="https://x.example/?e={{ email | url_encode }}">x</a>';
    const full = renderForRecipient(tpl, { greeting_name: "Chị Ngọc", company: "<b>Minh Khoa</b>", email: "ngoc.tran@example.com" });
    expect(full.html).toBe('Kính gửi Chị Ngọc, &lt;b&gt;Minh Khoa&lt;/b&gt; <a href="https://x.example/?e=ngoc.tran%40example.com">x</a>');
    const none = renderForRecipient(tpl, { greeting_name: null, company: "", email: "a@example.com" });
    expect(none.html).toMatch(/^Kính gửi Quý khách, {2}<a/);
    expect(none.missingWithoutFallback).toEqual(["company"]);
  });

  it("tolerates entity-encoded quotes inside braces (editors may encode them)", () => {
    const r = renderForRecipient("Chào {{ greeting_name | default: &quot;Quý khách&quot; }}", {});
    expect(r.html).toBe("Chào Quý khách");
  });

  it("never executes Liquid tags (no file access) and leaves bad fields visible", () => {
    const r = renderForRecipient("{% include '../../package.json' %} {{ ten_khach }} {{ company | defaul: 'x' }}", { company: "C" });
    expect(r.html).toContain("{% include '../../package.json' %}");
    expect(r.html).not.toContain('"name"');
    expect(r.errors.map((e) => e.error)).toEqual(["unknown field", "unknown filter"]);
  });
});

describe("lint", () => {
  it("flags relative, http, localhost and data images, missing alt, tracking pixels", () => {
    const l = lintTemplate(B);
    const msgs = l.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/relative URL/);
    expect(msgs).toMatch(/http \(not https\)/);
    expect(msgs).toMatch(/third-party tracking pixel/);
    expect(msgs).toMatch(/missing alt text/);
    expect(msgs).toMatch(/link text shows "www.ngan-hang-that.example" but goes to "shop.example"/);
    expect(msgs).toMatch(/empty or '#' link/);
    expect(msgs).toMatch(/unknown field/);
  });
  it("fixture A: root-relative images are errors (fine in the app preview, broken in real email)", () => {
    const l = lintTemplate(A);
    expect(l.findings.filter((f) => f.area === "image" && f.severity === "error")).toHaveLength(4);
    expect(l.findings.some((f) => f.code === "no_unsubscribe")).toBe(false);
  });
  it("warns about Gmail clipping above ~102 KB and missing unsubscribe", () => {
    const big = `<html><body><p>${"x".repeat(110 * 1024)}</p></body></html>`;
    const codes = lintTemplate(big).findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["gmail_clip", "no_unsubscribe"]));
  });
});

describe("plain-text part", () => {
  it("REGRESSION: never upper-cases headings (would break {{ full_name }} → {{ FULL_NAME }})", async () => {
    const { plainTextOf } = await import("../../src/lib/templates/service");
    const pt = plainTextOf(B);
    expect(pt).toContain("Flash sale 48 giờ cho {{ full_name }}!");
    expect(pt).not.toMatch(/FULL_NAME|FLASH SALE/);
    expect(plainTextOf("<table><tr><th>{{ company }}</th></tr></table>")).toContain("{{ company }}");
  });
});

describe("TipTap output → inline HTML", () => {
  it("joins paragraphs with <br><br> and drops a trailing empty paragraph", () => {
    expect(toInlineHtml("<p>Một</p><p>Hai <strong>đậm</strong></p><p></p>")).toBe("Một<br><br>Hai <strong>đậm</strong>");
    expect(toInlineHtml("không có p")).toBe("không có p");
  });
});
