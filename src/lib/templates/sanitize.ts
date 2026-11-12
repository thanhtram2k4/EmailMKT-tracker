/**
 * Email-template sanitization (allowlist), applied on every import and every save.
 *
 * Removes: scripts, iframes, objects/embeds, forms and inputs, SVG, event-handler attributes,
 * javascript:/vbscript:/data: (non-image) URLs, meta refresh, CSS expressions/behaviors,
 * @import in <style>. Keeps: email layout tags (tables, inline styles, <style> with media queries),
 * merge fields, MSO conditional comments (only if their inner markup contains nothing dangerous).
 * Other HTML comments are removed.
 *
 * The result is shown in a sandboxed iframe (no scripts) and exported; it is not a guarantee that
 * every email client renders it the same way.
 */
import sanitizeHtml from "sanitize-html";
import { parseHtml } from "./html-doc";

const ALLOWED_TAGS = [
  "html", "head", "body", "meta", "title", "style", "link",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "div", "span", "p", "br", "hr", "a", "img", "center", "font",
  "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "strike", "sup", "sub", "small", "big",
  "blockquote", "pre", "code", "ul", "ol", "li", "dl", "dt", "dd", "abbr", "address",
  "section", "article", "header", "footer", "main", "o:p",
];

const COMMON_ATTRS = [
  "style", "class", "id", "align", "valign", "width", "height", "bgcolor", "background", "border", "cellpadding",
  "cellspacing", "role", "dir", "lang", "title", "colspan", "rowspan", "nowrap", "color", "face", "size", "aria-hidden", "aria-label",
];

const DANGEROUS_TAGS = ["script", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "svg", "math", "frame", "frameset", "applet", "base", "noscript", "template"];
const BAD_CSS = /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i;
const BAD_URL = /^\s*(javascript|vbscript|data(?!:image\/(png|gif|jpe?g|webp);base64,))\s*:/i;
const DANGEROUS_INSIDE_CONDITIONAL = /<\s*(script|iframe|object|embed|form|input|meta|link)\b|javascript:|vbscript:|\son\w+\s*=/i;

export type SanitizeReport = {
  removedElements: Record<string, number>;
  removedEventHandlers: number;
  blockedUrls: Array<{ tag: string; attr: string; value: string }>;
  removedMetaRefresh: number;
  cleanedStyleAttributes: number;
  cleanedStyleBlocks: number;
  conditionalCommentsKept: number;
  conditionalCommentsDropped: number;
  plainCommentsRemoved: number;
  doctypeKept?: boolean;
  extracted?: { selector: string; found: boolean };
};

const PLACEHOLDER = (i: number) => `\u0000EMTCOND${i}\u0000`;

/** Optionally import only a fragment (e.g. "#email" from a tool page) wrapped in a minimal document. */
export function extractFragment(html: string, selector: string): { html: string; found: boolean } {
  const $ = parseHtml(html);
  const el = $(selector).first();
  if (!el.length) return { html, found: false };
  const styles = $("head style")
    .toArray()
    .map((s) => $.html(s))
    .join("\n");
  const title = $("head title").text();
  const lang = $("html").attr("lang") ?? "vi";
  return {
    found: true,
    html: `<!doctype html>\n<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n${styles}\n</head>\n<body>\n${$.html(el)}\n</body>\n</html>\n`,
  };
}

export function sanitizeEmailHtml(input: string): { html: string; report: SanitizeReport } {
  const report: SanitizeReport = {
    removedElements: {},
    removedEventHandlers: 0,
    blockedUrls: [],
    removedMetaRefresh: 0,
    cleanedStyleAttributes: 0,
    cleanedStyleBlocks: 0,
    conditionalCommentsKept: 0,
    conditionalCommentsDropped: 0,
    plainCommentsRemoved: 0,
  };

  // 1. Inventory what will be removed (for the report), using the same parser.
  const pre = parseHtml(input);
  for (const t of DANGEROUS_TAGS) {
    const n = pre(t).length;
    if (n) report.removedElements[t] = n;
  }
  pre("*").each((_, el) => {
    const attribs = (el as unknown as { attribs: Record<string, string> }).attribs ?? {};
    for (const [k, v] of Object.entries(attribs)) {
      if (/^on/i.test(k)) report.removedEventHandlers++;
      if (["href", "src", "background", "action", "data", "formaction", "xlink:href"].includes(k.toLowerCase()) && BAD_URL.test(v)) {
        report.blockedUrls.push({ tag: (el as unknown as { name: string }).name, attr: k, value: v.slice(0, 80) });
      }
    }
  });
  report.removedMetaRefresh = pre('meta[http-equiv="refresh" i]').length;

  // 2. Protect safe MSO conditional comments from the sanitizer (it drops all comments).
  const kept: string[] = [];
  // Order matters: "downlevel-revealed" markers (<!--[if !mso]><!-- --> … <!--<![endif]-->) are
  // protected as standalone markers, so the HTML BETWEEN them — which every non-Outlook client
  // renders — still goes through sanitization. Only hidden blocks (<!--[if mso]> … <![endif]-->,
  // never rendered by browsers) are protected as a whole.
  let work = input.replace(/<!--\[if[^\]]*\]><!--\s*-->|<!--\[if[^\]]*\]><!-->|<!--<!\[endif\]-->|<!--\[if[^\]]*\]>(?!<!--)[\s\S]*?<!\[endif\]-->/gi, (m) => {
    if (DANGEROUS_INSIDE_CONDITIONAL.test(m)) {
      report.conditionalCommentsDropped++;
      return "";
    }
    kept.push(m);
    report.conditionalCommentsKept++;
    return PLACEHOLDER(kept.length - 1);
  });
  report.plainCommentsRemoved = (work.match(/<!--[\s\S]*?-->/g) ?? []).length;
  work = work.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Allowlist sanitization.
  let html = sanitizeHtml(work, {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true, // <style> is needed for email; its content is cleaned below.
    allowedAttributes: {
      "*": COMMON_ATTRS,
      a: ["href", "target", "rel", "name", ...COMMON_ATTRS],
      img: ["src", "alt", ...COMMON_ATTRS],
      meta: ["name", "content", "charset", "http-equiv"],
      link: ["rel", "href", "type", "media"],
      html: ["xmlns", "xmlns:v", "xmlns:o", "lang", "dir"],
      style: ["type", "media"],
      table: ["summary", ...COMMON_ATTRS],
      col: ["span", ...COMMON_ATTRS],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "background", "cite"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    // Removed controls must not leave their labels behind as stray text (e.g. a form button "Gửi").
    nonTextTags: ["script", "style-unsafe", "textarea", "option", "select", "button", "noscript", "iframe", "object", "svg", "math", "template"],
    parser: { decodeEntities: false, lowerCaseAttributeNames: false },
    exclusiveFilter: (frame) => frame.tag === "meta" && /refresh/i.test(frame.attribs["http-equiv"] ?? ""),
    transformTags: {
      "*": (tagName, attribs) => {
        const a = { ...attribs };
        if (a.style && BAD_CSS.test(a.style)) {
          report.cleanedStyleAttributes++;
          a.style = a.style
            .split(";")
            .filter((d) => !BAD_CSS.test(d))
            .join(";");
        }
        if (a.background && BAD_URL.test(a.background)) delete a.background;
        return { tagName, attribs: a };
      },
      link: (tagName, attribs) => {
        // Only external https stylesheets survive (web fonts); everything else is dropped.
        if ((attribs.rel ?? "").toLowerCase() !== "stylesheet" || !/^https:\/\//i.test(attribs.href ?? "")) return { tagName: "", attribs: {} };
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        const a = { ...attribs };
        if (a.src && /^data:/i.test(a.src) && !/^data:image\/(png|gif|jpe?g|webp);base64,/i.test(a.src)) delete a.src;
        return { tagName, attribs: a };
      },
    },
    textFilter: (text, tagName) => {
      if (tagName === "style" && BAD_CSS.test(text)) {
        report.cleanedStyleBlocks++;
        return text.replace(/@import[^;]*;/gi, "").replace(/expression\s*\([^)]*\)/gi, "").replace(/javascript:/gi, "");
      }
      return text;
    },
  });

  // 4. Restore the protected conditional comments.
  html = html.replace(/\u0000EMTCOND(\d+)\u0000/g, (_m, i) => kept[Number(i)]);

  // 5. Keep the original DOCTYPE. sanitize-html drops it, which switches browsers (and some mail
  //    clients) to quirks mode and changes table layout (found in the M3 trial: +360 px height).
  const doctype = /^\s*(<!doctype[^>]*>)/i.exec(input)?.[1];
  report.doctypeKept = Boolean(doctype);
  if (doctype && !/^\s*<!doctype/i.test(html)) html = `${doctype}\n${html.replace(/^\s+/, "")}`;
  return { html, report };
}

/** Inline-only allowlist for edited text blocks (TipTap output). Merge fields are plain text. */
export function sanitizeInline(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["b", "strong", "i", "em", "u", "s", "br", "a", "span", "sup", "sub", "small", "code"],
    allowedAttributes: { a: ["href", "target", "rel", "style"], span: ["style"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    disallowedTagsMode: "discard",
    parser: { decodeEntities: true },
    transformTags: {
      "*": (tagName, attribs) => {
        if (attribs.style && BAD_CSS.test(attribs.style)) delete attribs.style;
        return { tagName, attribs };
      },
    },
  });
}

export function isAllowedUrl(u: string, kind: "link" | "image"): boolean {
  const v = u.trim();
  if (!v) return false;
  if (/^\{\{[^}]+\}\}$/.test(v)) return kind === "link"; // a lone merge field, e.g. {{ unsubscribe_url }}
  if (kind === "image") return /^https?:\/\//i.test(v) || /^\/[^/]/.test(v) || /^data:image\/(png|gif|jpe?g|webp);base64,/i.test(v);
  return /^(https?:\/\/|mailto:|tel:)/i.test(v);
}
