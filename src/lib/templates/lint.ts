/**
 * Checks on a template's images, links, size and structure. These are static checks only:
 * they do NOT fetch remote URLs (no server-side requests to arbitrary hosts) and they do NOT
 * prove how Gmail/Outlook/mobile clients render the email.
 */
import { countConditionalComments, parseHtml } from "./html-doc";
import { scanMergeFields } from "./merge";

export type Severity = "error" | "warning" | "info";
export type Finding = { severity: Severity; area: "image" | "link" | "size" | "structure" | "merge" | "content"; code: string; message: string; detail?: string };

export type ImageInfo = { src: string; alt: string | null; width?: string; height?: string; issues: string[] };
export type LinkInfo = { href: string; text: string; issues: string[] };

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export function lintTemplate(html: string) {
  const $ = parseHtml(html);
  const findings: Finding[] = [];
  const images: ImageInfo[] = [];
  const links: LinkInfo[] = [];

  $("img").each((_, el) => {
    const src = ($(el).attr("src") ?? "").trim();
    const alt = $(el).attr("alt") ?? null;
    const issues: string[] = [];
    const w = $(el).attr("width");
    const h = $(el).attr("height");
    const pixel = w === "1" && h === "1";
    if (!src) issues.push("missing src");
    else if (/^data:/i.test(src)) issues.push(pixel ? "inline tracking pixel (data URI)" : "inline data: image — many clients block or clip it");
    else if (/^cid:/i.test(src)) issues.push("cid: reference — needs an attachment at send time");
    else if (/^https:\/\//i.test(src)) {
      if (/^(localhost|127\.|0\.0\.0\.0)/.test(host(src) ?? "")) issues.push("points to localhost — recipients cannot load it");
    } else if (/^http:\/\//i.test(src)) issues.push("http (not https) — may be blocked or warned about");
    else issues.push("relative URL — will not load in an email; must be re-hosted at an absolute https URL");
    if (pixel && !/^data:/i.test(src)) issues.push("third-party tracking pixel");
    if (!pixel && (alt === null || alt.trim() === "")) issues.push("missing alt text");
    if (!pixel && !w) issues.push("no width attribute (Outlook may render at native size)");
    images.push({ src, alt, width: w, height: h, issues });
  });

  $("a").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const issues: string[] = [];
    if (!href || href === "#") issues.push("empty or '#' link");
    else if (/^\{\{[\s\S]*\}\}$/.test(href)) issues.push("merge-field link (resolved at send time)");
    else if (/^mailto:|^tel:/i.test(href)) {
      /* fine */
    } else if (/^http:\/\//i.test(href)) issues.push("http (not https)");
    else if (!/^https:\/\//i.test(href)) issues.push("relative or unsupported URL");
    if (/\{\{/.test(href) && !/^\{\{[\s\S]*\}\}$/.test(href)) issues.push("contains a merge field");
    // Display text that looks like a different domain than the target (phishing pattern).
    const shown = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(text)?.[0]?.toLowerCase();
    const target = host(href);
    if (shown && target && !target.endsWith(shown.replace(/^www\./, "")) && !shown.endsWith(target)) issues.push(`link text shows "${shown}" but goes to "${target}"`);
    links.push({ href, text, issues });
  });

  for (const i of images) for (const x of i.issues) findings.push({ severity: /relative|localhost|missing src/.test(x) ? "error" : "warning", area: "image", code: "image", message: x, detail: i.src.slice(0, 120) });
  for (const l of links) for (const x of l.issues) findings.push({ severity: /empty|relative|shows/.test(x) ? "warning" : "info", area: "link", code: "link", message: x, detail: `${l.text.slice(0, 40)} → ${l.href.slice(0, 120)}` });

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > 102 * 1024) findings.push({ severity: "warning", area: "size", code: "gmail_clip", message: `HTML is ${(bytes / 1024).toFixed(0)} KB; Gmail clips messages over about 102 KB` });
  if (!$("a").toArray().some((a) => /unsubscribe|h[uủ]y\s*đăng\s*k[yý]/i.test($(a).text()) || /\{\{\s*unsubscribe_url/.test($(a).attr("href") ?? ""))) {
    findings.push({ severity: "warning", area: "content", code: "no_unsubscribe", message: "No unsubscribe link found ({{ unsubscribe_url }} is required before sending — M5)" });
  }
  const textLen = $("body").text().replace(/\s+/g, " ").trim().length;
  const contentImages = images.filter((i) => !(i.width === "1" && i.height === "1")).length;
  if (contentImages > 0 && textLen < 200) findings.push({ severity: "warning", area: "content", code: "image_heavy", message: "Very little live text: content may be inside images (not editable, invisible when images are blocked)" });
  const mso = countConditionalComments(html);
  if (mso) findings.push({ severity: "info", area: "structure", code: "mso", message: `${mso} Outlook conditional comment marker(s) preserved (not rendered by browsers)` });
  if (/@media/i.test($("style").text())) findings.push({ severity: "info", area: "structure", code: "media_queries", message: "Responsive @media rules present in <style> (some clients ignore <style>)" });
  if ($('link[rel="stylesheet"]').length) findings.push({ severity: "warning", area: "structure", code: "external_css", message: "External stylesheet (e.g. web font) — most email clients ignore it; keep fallbacks" });

  const merge = scanMergeFields(html);
  for (const u of merge.uses) if (u.problem) findings.push({ severity: u.problem === "missing_fallback_in_href" ? "warning" : "error", area: "merge", code: u.problem, message: `${u.problem.replace(/_/g, " ")}: ${u.raw}` });
  for (const u of merge.uses) if (!u.problem && !u.hasFallback && u.field !== "unsubscribe_url" && u.field !== "email" && u.context === "text") findings.push({ severity: "warning", area: "merge", code: "no_fallback", message: `no fallback text: ${u.raw}` });
  for (const t of merge.liquidTags) findings.push({ severity: "error", area: "merge", code: "liquid_tag", message: `Liquid tags are not supported and are not executed: ${t.slice(0, 60)}` });

  return { findings, images, links, merge, bytes };
}
