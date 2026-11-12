/**
 * Structure-preserving editing ("click-to-edit"): the template HTML is never rebuilt. Editable
 * regions (text blocks, images, links, buttons) are identified deterministically, and an edit
 * changes ONLY that node; every other byte of the document is serialized as parsed.
 *
 * Region ids (t1, i1, l1, b1…) are recomputed from document order for each version; edit
 * operations always reference the version they were made on.
 */
import type { AnyNode, Element } from "domhandler";
import { parseHtml, serialize, type Doc } from "./html-doc";
import { isAllowedUrl, sanitizeInline } from "./sanitize";

export type RegionKind = "text" | "image" | "link" | "button";
export type Region = {
  id: string;
  kind: RegionKind;
  label: string;
  hidden: boolean;
  html?: string; // text: inner HTML
  text?: string;
  href?: string;
  src?: string;
  alt?: string;
  width?: string;
  /** Inline formatting the rich-text editor cannot reproduce (warn before editing). */
  unsupportedInline?: string[];
};

const INLINE = new Set(["b", "strong", "i", "em", "u", "s", "strike", "br", "span", "a", "font", "sup", "sub", "small", "big", "code", "abbr"]);
const TEXT_CONTAINERS = new Set(["td", "th", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "div", "blockquote", "center", "dd", "dt", "pre", "span", "address"]);

const isEl = (n: AnyNode): n is Element => n.type === "tag";

function inlineOnly(el: Element): boolean {
  return el.children.every((c) => {
    if (c.type === "text") return true;
    if (c.type === "comment") return false;
    if (!isEl(c)) return false;
    if (c.name === "img") return false;
    return INLINE.has(c.name) && inlineOnly(c);
  });
}

function hasText($: Doc, el: Element) {
  return $(el).text().replace(/\s+/g, "").length > 0;
}

function isHidden($: Doc, el: Element) {
  const style = ($(el).attr("style") ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("mso-hide:all");
}

function looksLikeButton($: Doc, a: Element): boolean {
  const style = ($(a).attr("style") ?? "").toLowerCase();
  const cls = ($(a).attr("class") ?? "").toLowerCase();
  if (/\b(btn|button|cta)\b/.test(cls)) return true;
  if (/background(-color)?\s*:/.test(style) && /(padding|line-height)\s*:/.test(style)) return true;
  if ($(a).attr("role") === "button") return true;
  return false;
}

function unsupportedInline($: Doc, el: Element): string[] {
  const out = new Set<string>();
  $(el)
    .find("span[style], font, a[style], b[style], strong[style], em[style], i[style]")
    .each((_, x) => {
      const name = (x as Element).name;
      const style = $(x).attr("style");
      if (name === "font") out.add("<font> (colour/face/size)");
      else if (style) out.add(`inline style on <${name}>: ${style.slice(0, 60)}`);
    });
  return [...out];
}

/** Annotate regions with data-emt-id (in memory) and describe them. */
export function annotate(html: string): { $: Doc; regions: Region[] } {
  const $ = parseHtml(html);
  const regions: Region[] = [];
  const counters = { t: 0, i: 0, l: 0, b: 0 };
  const all = $("body").length ? $("body").find("*") : $("*");

  all.each((_, node) => {
    const el = node as Element;
    if ($(el).closest("[data-emt-id]").length && el.name !== "a") return; // inside a text region
    if (el.name === "img") {
      const w = $(el).attr("width");
      const h = $(el).attr("height");
      if (w === "1" && h === "1") return; // tracking pixel: not content
      const id = `i${++counters.i}`;
      $(el).attr("data-emt-id", id);
      regions.push({ id, kind: "image", label: $(el).attr("alt") || $(el).attr("src")?.split("/").pop() || "image", hidden: false, src: $(el).attr("src") ?? "", alt: $(el).attr("alt") ?? "", width: w });
      return;
    }
    if (el.name === "a" && $(el).attr("href") !== undefined) {
      if ($(el).attr("data-emt-id")) return;
      const button = looksLikeButton($, el);
      const id = button ? `b${++counters.b}` : `l${++counters.l}`;
      $(el).attr("data-emt-id", id);
      regions.push({ id, kind: button ? "button" : "link", label: $(el).text().trim().slice(0, 60) || $(el).attr("href")!, hidden: false, href: $(el).attr("href"), text: $(el).text().trim() });
      return;
    }
    // A container whose only content is one button-like link is not a text block: the button is
    // its own region, so its styling can never be flattened by the rich-text editor.
    const onlyButton = (() => {
      const kids = el.children.filter((c) => !(c.type === "text" && !String((c as { data?: string }).data ?? "").trim()));
      return kids.length === 1 && isEl(kids[0]) && kids[0].name === "a" && looksLikeButton($, kids[0]);
    })();
    if (TEXT_CONTAINERS.has(el.name) && !onlyButton && inlineOnly(el) && hasText($, el)) {
      // Only the outermost inline-only container becomes a region.
      const parent = el.parent && isEl(el.parent) ? el.parent : null;
      if (parent && TEXT_CONTAINERS.has(parent.name) && inlineOnly(parent) && hasText($, parent) && parent.name !== "body") return;
      const id = `t${++counters.t}`;
      $(el).attr("data-emt-id", id);
      regions.push({
        id,
        kind: "text",
        label: $(el).text().replace(/\s+/g, " ").trim().slice(0, 70),
        hidden: isHidden($, el),
        html: $(el).html() ?? "",
        text: $(el).text().replace(/\s+/g, " ").trim(),
        unsupportedInline: unsupportedInline($, el),
      });
      // Links inside the text block stay individually editable (href).
      $(el)
        .find("a[href]")
        .each((__, a) => {
          const button = looksLikeButton($, a as Element);
          const aid = button ? `b${++counters.b}` : `l${++counters.l}`;
          $(a).attr("data-emt-id", aid);
          regions.push({ id: aid, kind: button ? "button" : "link", label: $(a).text().trim().slice(0, 60) || $(a).attr("href")!, hidden: false, href: $(a).attr("href"), text: $(a).text().trim() });
        });
    }
  });
  return { $, regions };
}

export function regionsOf(html: string): Region[] {
  return annotate(html).regions;
}

/** HTML with data-emt-id attributes, for the click-to-select preview. */
export function annotatedHtml(html: string): string {
  return serialize(annotate(html).$);
}

export type EditOp =
  | { id: string; kind: "text"; html: string }
  | { id: string; kind: "image"; src?: string; alt?: string }
  | { id: string; kind: "link"; href: string }
  | { id: string; kind: "button"; href?: string; text?: string };

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

/** Replace the deepest text node of an element, keeping wrapping inline markup (e.g. <span>). */
function setDeepText($: Doc, el: Element, text: string) {
  let target: Element = el;
  for (;;) {
    const kids = target.children.filter((c) => !(c.type === "text" && !("data" in c && String((c as { data: string }).data).trim())));
    if (kids.length === 1 && isEl(kids[0])) target = kids[0];
    else break;
  }
  $(target).text(text);
}

/** Apply edits and return the new canonical HTML (annotations removed). */
export function applyEdits(html: string, ops: EditOp[]): { html: string; applied: string[] } {
  const { $ } = annotate(html);
  const applied: string[] = [];
  for (const op of ops) {
    const el = $(`[data-emt-id="${op.id}"]`).first();
    if (!el.length) throw new EditError(`Region ${op.id} no longer exists in this version`);
    const node = el.get(0) as Element;
    switch (op.kind) {
      case "text":
        if (node.name === "img" || node.name === "a") throw new EditError(`${op.id} is not a text block`);
        el.html(sanitizeInline(op.html));
        break;
      case "image":
        if (node.name !== "img") throw new EditError(`${op.id} is not an image`);
        if (op.src !== undefined) {
          if (!isAllowedUrl(op.src, "image")) throw new EditError(`Image URL not allowed: ${op.src}`);
          el.attr("src", op.src.trim());
        }
        if (op.alt !== undefined) el.attr("alt", op.alt);
        break;
      case "link":
      case "button":
        if (node.name !== "a") throw new EditError(`${op.id} is not a link`);
        if ("href" in op && op.href !== undefined) {
          if (!isAllowedUrl(op.href, "link")) throw new EditError(`Link not allowed (use https://, mailto:, tel: or a merge field): ${op.href}`);
          el.attr("href", op.href.trim());
        }
        if (op.kind === "button" && op.text !== undefined) setDeepText($, node, op.text);
        break;
    }
    applied.push(op.id);
  }
  $("[data-emt-id]").removeAttr("data-emt-id");
  return { html: serialize($), applied };
}

/** Strip editor annotations (defensive; canonical HTML never stores them). */
export function stripAnnotations(html: string): string {
  const $ = parseHtml(html);
  $("[data-emt-id]").removeAttr("data-emt-id");
  return serialize($);
}
