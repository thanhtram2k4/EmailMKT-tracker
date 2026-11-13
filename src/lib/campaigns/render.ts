/**
 * Per-recipient rendering of a frozen snapshot, and snapshot helpers (link table, content hash).
 * Merge values come from campaign_recipients (frozen at approval); `unsubscribe_url` is built from
 * the message's opaque tracking token, never from an email address.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseHtml, serialize } from "../templates/html-doc";
import { renderForRecipient, renderSubject, renderText, scanMergeFields, type Recipient } from "../templates/merge";

export type MergeValues = { full_name: string | null; greeting_name: string | null; company: string | null; email: string };

export const newTrackingToken = () => randomBytes(16).toString("base64url");

export const unsubscribeUrl = (trackingBaseUrl: string, token: string) => `${trackingBaseUrl}/u/${encodeURIComponent(token)}`;

export function contentHash(subject: string, html: string, text: string): string {
  return createHash("sha256").update(subject).update("\u0000").update(html).update("\u0000").update(text).digest("hex");
}

export type RenderedMessage = {
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  problems: string[];
};

export const clickUrl = (trackingBaseUrl: string, token: string, idx: number) => `${trackingBaseUrl}/c/${encodeURIComponent(token)}/${idx}`;
export const openPixelUrl = (trackingBaseUrl: string, token: string) => `${trackingBaseUrl}/o/${encodeURIComponent(token)}.gif`;

/** A link that is recorded in the snapshot's link table (and therefore tracked): absolute http(s), no merge field. */
const isTrackableHref = (href: string) => /^https?:\/\//i.test(href) && !href.includes("{{");

/**
 * M7: rewrite trackable links to the click endpoint and add the open pixel. Runs on the FROZEN
 * template HTML before merge fields are rendered, with the same selection and order as
 * extractLinks(), so link index n always means the snapshot's link n. Links inside comments (e.g.
 * MSO conditionals) are not seen by either and stay direct. The plain-text part is not rewritten.
 */
export function applyTracking(html: string, token: string, trackingBaseUrl: string): string {
  const $ = parseHtml(html);
  let idx = 0;
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!isTrackableHref(href)) return;
    $(el).attr("href", clickUrl(trackingBaseUrl, token, idx++));
  });
  const pixel = `<img src="${openPixelUrl(trackingBaseUrl, token)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  if ($("body").length) $("body").first().append(pixel);
  else $.root().append(pixel);
  return serialize($);
}

export function renderMessage(
  s: { subjectTemplate: string; html: string; plainText: string },
  mv: MergeValues,
  token: string,
  trackingBaseUrl: string,
  o: { track?: boolean } = {},
): RenderedMessage {
  const unsub = unsubscribeUrl(trackingBaseUrl, token);
  const data: Recipient = { ...mv, unsubscribe_url: unsub };
  const subj = renderSubject(s.subjectTemplate, data);
  const body = renderForRecipient(o.track ? applyTracking(s.html, token, trackingBaseUrl) : s.html, data);
  const text = renderText(s.plainText, data);
  const problems = [
    ...subj.errors.map((e) => `subject: ${e.raw} — ${e.error}`),
    ...body.errors.map((e) => `body: ${e.raw} — ${e.error}`),
    ...text.errors.map((e) => `plain text: ${e.raw} — ${e.error}`),
    ...[...new Set([...subj.missingWithoutFallback, ...body.missingWithoutFallback])].map((f) => `${f}: no value and no default`),
  ];
  // The plain-text part must always carry a working opt-out, even if the template's text omits it.
  const textOut = text.text.includes(unsub) ? text.text : `${text.text}\n\n---\nHủy đăng ký / Unsubscribe: ${unsub}`;
  return { subject: subj.subject, html: body.html, text: textOut, unsubscribeUrl: unsub, problems };
}

/** RFC 2369 / RFC 8058 headers for one-click unsubscribe. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/** True when the body links to {{ unsubscribe_url }} in an href (the visible footer link). */
export function hasUnsubscribeLink(html: string): boolean {
  const $ = parseHtml(html);
  let found = false;
  $("a[href]").each((_, el) => {
    if (/\{\{\s*unsubscribe_url\b[^}]*\}\}/.test($(el).attr("href") ?? "")) found = true;
  });
  if (found) return true;
  // Inside comments (e.g. MSO conditionals) cheerio does not see anchors; fall back to the scanner.
  return scanMergeFields(html).uses.some((u) => u.field === "unsubscribe_url" && u.context === "attribute");
}

/** Absolute http(s) links in the snapshot, in document order (merge-field and mailto links excluded). */
export function extractLinks(html: string): Array<{ idx: number; url: string; label: string | null }> {
  const $ = parseHtml(html);
  const out: Array<{ idx: number; url: string; label: string | null }> = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!isTrackableHref(href)) return;
    const label = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200) || $(el).find("img").attr("alt")?.slice(0, 200) || null;
    out.push({ idx: out.length, url: href, label });
  });
  return out;
}
