/**
 * M7 open / click recording (DESIGN §4.3).
 *  - Opaque tokens only; a token is accepted only for a message that was sent WITH tracking.
 *  - A click redirects ONLY to the URL stored at that index in the message's snapshot link table;
 *    anything else (unknown token, index out of range, tracking off) is a 404, never a redirect.
 *  - Raw events are always kept. Automated-activity flags are additive:
 *      scanner_ua / no_user_agent   known scanners, link checkers, HTTP libraries, empty UA;
 *      head_request                  HEAD instead of GET (link pre-checks);
 *      fast_click                    a click less than 10 s after delivery (or after sending);
 *      multi_link_burst              different links of one message clicked within 2 s (all flagged);
 *      proxy_open                    a mail provider's image proxy (label only: not counted as automated,
 *                                    because Gmail proxies real opens too).
 *  - The client IP is stored only as a keyed hash; the user agent is truncated.
 *  - Non-automated activity updates the contact's last_engagement_at.
 */
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaignLinks, campaignRecipients, messageEvents, messages } from "../db/schema";
import { TOKEN_RE } from "./unsubscribe";

export const FAST_CLICK_MS = 10_000;
export const BURST_MS = 2_000;

const SCANNER_UA =
  /(bot\b|bot\/|crawl|spider|slurp|scanner|preview|barracuda|proofpoint|mimecast|safelinks|symantec|forcepoint|trendmicro|sophos|fortinet|python-requests|python-urllib|curl\/|wget|go-http-client|java\/|okhttp|libwww|httpclient|headlesschrome|phantomjs)/i;
const PROXY_UA = /(googleimageproxy|ggpht\.com|yahoomailproxy)/i;
const AUTOMATED_FLAGS = new Set(["scanner_ua", "no_user_agent", "head_request", "fast_click", "multi_link_burst"]);

export type RequestInfo = { ip: string | null; userAgent: string | null; method: string; now?: Date };

export function uaFlags(ua: string | null, kind: "open" | "click"): string[] {
  const f: string[] = [];
  if (!ua || !ua.trim()) f.push("no_user_agent");
  else if (SCANNER_UA.test(ua)) f.push("scanner_ua");
  if (kind === "open" && ua && PROXY_UA.test(ua)) f.push("proxy_open");
  return f;
}

export const isAutomated = (flags: string[]) => flags.some((f) => AUTOMATED_FLAGS.has(f));

export function hashIp(ip: string | null, secret: string): string | null {
  if (!ip) return null;
  return createHmac("sha256", secret).update(ip.trim()).digest("hex").slice(0, 32);
}

type TrackedMessage = typeof messages.$inferSelect;

async function trackedMessage(db: Db, token: string): Promise<TrackedMessage | null> {
  if (!TOKEN_RE.test(token)) return null;
  const m = (await db.select().from(messages).where(eq(messages.trackingToken, token)).limit(1))[0];
  // Only messages that actually went out with tracking links can produce tracking events.
  if (!m || m.trackingEnabled !== true || !["sent", "unknown", "marked_not_sent"].includes(m.sendStatus)) return null;
  return m;
}

async function touchEngagement(db: Db, m: TrackedMessage, at: Date) {
  const r = (await db.select({ contactId: campaignRecipients.contactId }).from(campaignRecipients).where(eq(campaignRecipients.id, m.recipientId)).limit(1))[0];
  if (r?.contactId) {
    await db.execute(sql`update contacts set last_engagement_at = greatest(coalesce(last_engagement_at, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)
                         where id = ${r.contactId}`);
  }
}

export async function recordOpen(db: Db, token: string, req: RequestInfo, secret: string): Promise<boolean> {
  const m = await trackedMessage(db, token);
  if (!m) return false;
  const now = req.now ?? new Date();
  const flags = uaFlags(req.userAgent, "open");
  if (req.method === "HEAD") flags.push("head_request");
  const automated = isAutomated(flags);
  await db.insert(messageEvents).values({
    messageId: m.id,
    campaignId: m.campaignId,
    type: "open",
    occurredAt: now,
    receivedAt: now,
    ipHash: hashIp(req.ip, secret),
    userAgent: req.userAgent?.slice(0, 300) ?? null,
    flags,
    suspectedAutomated: automated,
  });
  if (!automated) await touchEngagement(db, m, now);
  return true;
}

/** Returns the snapshot URL to redirect to, or null (→ 404, no redirect). */
export async function recordClick(db: Db, token: string, idxRaw: string, req: RequestInfo, secret: string): Promise<string | null> {
  if (!/^\d{1,4}$/.test(idxRaw)) return null;
  const idx = Number(idxRaw);
  const m = await trackedMessage(db, token);
  if (!m) return null;
  const link = (await db.select().from(campaignLinks).where(and(eq(campaignLinks.snapshotId, m.snapshotId), eq(campaignLinks.idx, idx))).limit(1))[0];
  if (!link) return null;
  const now = req.now ?? new Date();

  const flags = uaFlags(req.userAgent, "click");
  if (req.method === "HEAD") flags.push("head_request");
  // Fast click: compared with the first Delivery event, or the send time when no event arrived.
  const delivered = (
    await db.execute(sql`select min(occurred_at) as at from message_events where message_id = ${m.id} and type = 'delivery'`)
  ).rows[0] as { at: string | null };
  const base = delivered.at ? new Date(delivered.at) : m.sentAt;
  if (base && now.getTime() - base.getTime() >= 0 && now.getTime() - base.getTime() < FAST_CLICK_MS) flags.push("fast_click");
  // Burst: another link of the same message clicked within 2 s → flag this click and those.
  const from = new Date(now.getTime() - BURST_MS).toISOString();
  const to = new Date(now.getTime() + BURST_MS).toISOString();
  const burst = (
    await db.execute(sql`select id from message_events where message_id = ${m.id} and type = 'click' and link_idx <> ${idx}
                         and occurred_at between ${from}::timestamptz and ${to}::timestamptz`)
  ).rows as Array<{ id: number }>;
  if (burst.length) {
    flags.push("multi_link_burst");
    await db.execute(sql`update message_events set flags = array_append(flags, 'multi_link_burst'), suspected_automated = true
                         where id in (${sql.join(burst.map((b) => sql`${b.id}`), sql`, `)}) and not ('multi_link_burst' = any(flags))`);
  }
  const automated = isAutomated(flags);
  await db.insert(messageEvents).values({
    messageId: m.id,
    campaignId: m.campaignId,
    type: "click",
    linkIdx: idx,
    occurredAt: now,
    receivedAt: now,
    ipHash: hashIp(req.ip, secret),
    userAgent: req.userAgent?.slice(0, 300) ?? null,
    flags,
    suspectedAutomated: automated,
  });
  if (!automated) await touchEngagement(db, m, now);
  return link.url;
}

