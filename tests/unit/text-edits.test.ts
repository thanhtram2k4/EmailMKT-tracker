/**
 * M3 rev 2: formatting-preserving text edits, the explicit-choice rule for formatting loss, and
 * the inline sanitizer. Uses the labelled INTERNAL fixture fixtures/email-templates/internal-paste-workflow.html.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdits, EditError, regionsOf, type EditOp } from "../../src/lib/templates/editable";
import { countConditionalComments } from "../../src/lib/templates/html-doc";
import { scanMergeFields } from "../../src/lib/templates/merge";
import { sanitizeEmailHtml, sanitizeInline } from "../../src/lib/templates/sanitize";
import { editNote, nameFromHtml } from "../../src/lib/templates/service";
import { encodeText, formatDiff, textStructure } from "../../src/lib/templates/text-runs";

const RAW = fs.readFileSync("fixtures/email-templates/internal-paste-workflow.html", "utf8");
const P = sanitizeEmailHtml(RAW).html;
const regions = regionsOf(P);
const byText = (start: string) => regions.find((r) => r.kind === "text" && r.text?.startsWith(start))!;
const PARA = byText("Kính gửi");
const H1 = byText("Bản tin tháng 11");
const LINKP = byText("Xem chi tiết");

/** What saveStructuredEdits stores: the edits applied, then the whole document re-sanitized. */
const save = (ops: EditOp[]) => sanitizeEmailHtml(applyEdits(P, ops).html).html;
const SPAN = '<span style="color:#c0392b;font-weight:bold">';
const FONT = '<font color="#1f5f8b" face="Georgia">';

/** Build a text-runs op from a region by transforming its gaps. */
function runs(r: (typeof regions)[number], edit: (gaps: string[][]) => void): EditOp {
  const s = textStructure(r.html!);
  edit(s.gaps);
  return { id: r.id, kind: "text-runs", tags: s.tags, gaps: s.gaps };
}

describe("text structure", () => {
  it("records element tags with depth and decoded text gaps", () => {
    const s = textStructure('A <span style="x">B <b>C</b></span> &amp; D');
    expect(s.tags).toEqual(["1:span", "2:b"]);
    expect(s.gaps).toEqual([["A ", " & D"], ["B ", ""], ["C"]]);
  });
  it("distinguishes tree shapes with the same tag order", () => {
    expect(textStructure("<b><i>x</i></b>").tags).not.toEqual(textStructure("<b></b><i>x</i>").tags);
  });
  it("normalizes CRLF so browser and server text compare equal", () => {
    const crlf = "a" + String.fromCharCode(13, 10) + "b";
    expect(textStructure(crlf).gaps[0][0]).toBe(textStructure("a" + String.fromCharCode(10) + "b").gaps[0][0]);
  });
  it("encodes text so it can never become markup", () => {
    expect(encodeText('<script>x</script> & "q"')).toBe('&lt;script&gt;x&lt;/script&gt; &amp; "q"');
  });
});

describe("formatting-preserving text edits (text-runs)", () => {
  it("the internal fixture's regions are found and the sanitizer is idempotent on it", () => {
    expect(PARA.tags).toEqual(["1:span", "1:font"]);
    expect(H1.tags).toEqual([]);
    // Labels are decoded and in document order.
    expect(LINKP.text).toBe("Xem chi tiết ưu đãi & điều kiện áp dụng.");
    expect(PARA.text).toContain("chương trình GIẢM 30% cho khách hàng thân thiết đã bắt đầu.");
    expect(sanitizeEmailHtml(P).html).toBe(P);
  });

  it("appending text changes only that text: every other byte is identical", () => {
    const out = save([runs(PARA, (g) => (g[0][2] += " Cảm ơn!"))]);
    expect(out).toBe(P.replace("đã bắt đầu. Hãy đăng ký sớm.</p>", "đã bắt đầu. Hãy đăng ký sớm. Cảm ơn!</p>"));
  });

  it("editing text inside a styled span keeps the span and its style", () => {
    const out = save([runs(PARA, (g) => (g[1][0] = "GIẢM 40%"))]);
    expect(out).toBe(P.replace(`${SPAN}GIẢM 30%</span>`, `${SPAN}GIẢM 40%</span>`));
    expect(out).toContain(`${FONT}khách hàng thân thiết</font>`);
  });

  it("a typed merge field is kept exactly and stays a valid merge field", () => {
    const out = save([runs(H1, (g) => (g[0][0] = 'Chào {{ greeting_name | default: "Quý khách" }}'))]);
    expect(out).toContain('>Chào {{ greeting_name | default: "Quý khách" }}</h1>');
    const before = scanMergeFields(P).uses.map((u) => u.raw);
    const after = scanMergeFields(out).uses.map((u) => u.raw);
    expect(after.length).toBe(before.length + 1);
    expect(scanMergeFields(out).uses.every((u) => !u.problem)).toBe(true);
  });

  it("unchanged gaps keep their raw entities when another gap of the block changes", () => {
    const out = save([runs(LINKP, (g) => (g[0][0] = "Xem ngay "))]);
    expect(out).toContain("Xem ngay <a");
    expect(out).toContain("</a> &amp; điều kiện áp dụng.</p>");
  });

  it("typed markup is stored as text, never as HTML (security)", () => {
    const out = save([runs(H1, (g) => (g[0][0] = '<img src=x onerror="alert(1)"><script>alert(2)</script>'))]);
    expect(out).not.toMatch(/<script|<img src=x/i);
    expect(out).toContain('&lt;img src=x onerror="alert(1)"&gt;&lt;script&gt;alert(2)&lt;/script&gt;</h1>');
  });

  it("rejects a text-runs op whose structure does not match the stored block", () => {
    const op = runs(PARA, () => undefined) as Extract<EditOp, { kind: "text-runs" }>;
    expect(() => applyEdits(P, [{ ...op, tags: ["1:span"] }])).toThrow(EditError);
    expect(() => applyEdits(P, [{ ...op, gaps: [["only one gap"]] }])).toThrow(EditError);
    expect(() => applyEdits(P, [{ ...op, id: "i1" }])).toThrow(EditError);
  });

  it("text edits and an edit of a link inside the same block both apply, in either order", () => {
    const link = regions.find((r) => r.kind === "link" && r.href === "https://anphat.example/uu-dai")!;
    const text = runs(LINKP, (g) => (g[0][0] = "Xem ngay "));
    const l: EditOp = { id: link.id, kind: "link", href: "https://anphat.example/uu-dai-thang-11" };
    const a = save([l, text]);
    const b = save([text, l]);
    expect(a).toBe(b);
    expect(a).toBe(P.replace('Xem <a href="https://anphat.example/uu-dai"', 'Xem ngay <a href="https://anphat.example/uu-dai-thang-11"'));
  });
});

describe("formatting loss needs an explicit choice", () => {
  const plain = "Kính gửi Quý khách, chương trình GIẢM 30% đã bắt đầu.";

  it("an HTML replacement that removes formatting is refused without acceptFormatChange", () => {
    expect(() => applyEdits(P, [{ id: PARA.id, kind: "text", html: plain }])).toThrow('would remove formatting: <span style="color:#c0392b;font-weight:bold"> around “GIẢM 30%”; <font color="#1f5f8b" face="Georgia"> around “khách hàng thân thiết”');
  });

  it("with acceptFormatChange it is applied and the removal is reported", () => {
    const r = applyEdits(P, [{ id: PARA.id, kind: "text", html: plain, mode: "inplace", acceptFormatChange: true }]);
    expect(r.html).toContain(`>${plain}</p>`);
    expect(r.formatChanges).toEqual([expect.objectContaining({ id: PARA.id, mode: "inplace", removed: expect.arrayContaining([expect.objectContaining({ tag: "span" }), expect.objectContaining({ tag: "font" })]) })]);
    expect(editNote([{ id: PARA.id, kind: "text", html: plain, mode: "inplace", acceptFormatChange: true }], r.formatChanges)).toMatch(/formatting removed \(accepted\): <span/);
  });

  it("adding formatting without removing any is allowed without a confirmation", () => {
    const html = (PARA.html ?? "").replace("Hãy đăng ký sớm.", "Hãy <strong>đăng ký</strong> sớm.");
    const r = applyEdits(P, [{ id: PARA.id, kind: "text", html, mode: "rich" }]);
    expect(r.html).toContain("Hãy <strong>đăng ký</strong> sớm.</p>");
    expect(r.html).toContain(`${SPAN}GIẢM 30%</span>`);
    expect(r.formatChanges[0].removed).toEqual([]);
  });

  it("an HTML-source edit keeps nested link ids so a link edit in the same save still applies", () => {
    const link = regions.find((r) => r.kind === "link" && r.href === "https://anphat.example/uu-dai")!;
    const html = (LINKP.html ?? "").replace("<a ", `<a data-emt-id="${link.id}" `).replace("Xem ", "Mời xem ");
    const out = applyEdits(P, [
      { id: LINKP.id, kind: "text", html, mode: "source", acceptFormatChange: true },
      { id: link.id, kind: "link", href: "https://anphat.example/moi" },
    ]).html;
    expect(out).toContain('Mời xem <a href="https://anphat.example/moi"');
    expect(out).not.toContain("data-emt-id");
  });
});

describe("format diff", () => {
  it("ignores editor attributes and link destinations, detects style changes", () => {
    expect(formatDiff('<a href="x" data-emt-id="l1">t</a>', '<a href="y">t</a>').removed).toEqual([]);
    const d = formatDiff('<span style="color:red">a</span>', '<span style="color:blue">a</span>');
    expect(d.textOnly).toBe(false);
    expect(d.removed[0]).toMatchObject({ tag: "span", attrs: 'style="color:red"' });
    expect(d.added[0]).toMatchObject({ tag: "span", attrs: 'style="color:blue"' });
  });
});

describe("inline sanitizer (HTML source / toolbar edits)", () => {
  it("keeps the inline formatting the document sanitizer allows", () => {
    const html = '<font color="#1f5f8b" face="Georgia">a</font> <strong style="color:red" class="x">b</strong> <span style="font-size:18px">c</span>';
    expect(sanitizeInline(html)).toBe(html);
  });
  it("still removes scripts, handlers, javascript: links, images and block tags", () => {
    const out = sanitizeInline('<script>alert(1)</script><a href="javascript:alert(2)" onclick="x()">l</a><img src=x onerror=alert(3)><div style="color:red">d</div><span style="background:url(javascript:alert(4))">s</span>');
    expect(out).not.toMatch(/script|javascript|onclick|onerror|<img|<div/i);
    expect(out).toContain("d");
    expect(out).toContain("<span>s</span>");
  });
  it("drops editor ids unless asked to keep them", () => {
    expect(sanitizeInline('<a href="https://e.example" data-emt-id="l1">x</a>')).toBe('<a href="https://e.example">x</a>');
    expect(sanitizeInline('<a href="https://e.example" data-emt-id="l1">x</a>', { keepEditorIds: true })).toContain('data-emt-id="l1"');
  });
});

describe("import without a selector", () => {
  it("a complete email document is imported as a whole: doctype, head styles and MSO kept", () => {
    expect(P.startsWith("<!DOCTYPE html PUBLIC")).toBe(true);
    expect(P).toContain("@media only screen and (max-width:620px)");
    expect(countConditionalComments(P)).toBe(countConditionalComments(RAW));
    expect(nameFromHtml(P)).toBe("INTERNAL FIXTURE – Paste workflow");
  });
});
