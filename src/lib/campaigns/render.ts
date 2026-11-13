/**
 * Per-recipient rendering of a frozen snapshot, and snapshot helpers (link table, content hash).
 * Merge values come from campaign_recipients (frozen at approval); `unsubscribe_url` is built from
 * the message's opaque tracking token, never from an email address.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseHtml } from "../templates/html-doc";
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

export function renderMessage(s: { subjectTemplate: string; html: string; plainText: string }, mv: MergeValues, token: string, trackingBaseUrl: string): RenderedMessage {
  const unsub = unsubscribeUrl(trackingBaseUrl, token);
  const data: Recipient = { ...mv, unsubscribe_url: unsub };
  const subj = renderSubject(s.subjectTemplate, data);
  const body = renderForRecipient(s.html, data);
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
    if (!/^https?:\/\//i.test(href) || href.includes("{{")) return;
    const label = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200) || $(el).find("img").attr("alt")?.slice(0, 200) || null;
    out.push({ idx: out.length, url: href, label });
  });
  return out;
}
