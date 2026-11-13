/** Shared HTTP helpers for the public tracking endpoints (/o, /c). */
import type { RequestInfo } from "./tracking";

/** Client IP as seen by the app: the first X-Forwarded-For hop (set by the hosting proxy), else X-Real-IP. */
export function requestInfo(req: Request): RequestInfo {
  const xff = req.headers.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0] : req.headers.get("x-real-ip"))?.trim() || null;
  return { ip, userAgent: req.headers.get("user-agent"), method: req.method.toUpperCase() };
}

export const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate, private", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };

export const notFound = () => new Response("Not found", { status: 404, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });

/** 1×1 transparent GIF. */
export const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
