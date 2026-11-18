/** Shared HTTP helpers for the public tracking endpoints (/o, /c). */
import { getConfig } from "../config";
import { clientIp, publicLimiter, tooManyRequests, type Bucket } from "../security/rate-limit";
import type { RequestInfo } from "./tracking";

/**
 * Client IP: the X-Forwarded-For entry appended by our own proxy (TRUSTED_PROXY_HOPS from the right).
 * M8 fix: M7 used the LEFT-most entry, which the client can forge.
 */
export function requestInfo(req: Request): RequestInfo {
  return { ip: clientIp(req.headers, getConfig().TRUSTED_PROXY_HOPS), userAgent: req.headers.get("user-agent"), method: req.method.toUpperCase() };
}

/** M8: per-client abuse limit for a public endpoint; returns a 429 response when exceeded. */
export function limited(req: Request, bucket: Bucket): Response | null {
  const ip = bucket === "ses_events" ? "sns" : clientIp(req.headers, getConfig().TRUSTED_PROXY_HOPS);
  const r = publicLimiter().hit(bucket, ip);
  return r.allowed ? null : tooManyRequests(r.retryAfterS);
}

export const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate, private", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };

export const notFound = () => new Response("Not found", { status: 404, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });

/** 1×1 transparent GIF. */
export const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
