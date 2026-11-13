/**
 * Public open pixel: GET /o/<token>.gif (DESIGN §4.3). Records an open for a message sent with
 * tracking; unknown or untracked tokens get 404. Opens are unreliable by nature (image blocking,
 * proxy caching, Apple prefetching) — see the analytics page notes.
 */
import { getConfig } from "../../../lib/config";
import { getDb } from "../../../lib/db/client";
import { recordOpen } from "../../../lib/campaigns/tracking";
import { NO_STORE, notFound, PIXEL, requestInfo } from "../../../lib/campaigns/tracking-http";

export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const m = /^([A-Za-z0-9_-]{16,64})\.gif$/.exec(file);
  if (!m) return notFound();
  const ok = await recordOpen(getDb(), m[1], requestInfo(req), getConfig().BETTER_AUTH_SECRET);
  if (!ok) return notFound();
  return new Response(req.method === "HEAD" ? null : new Uint8Array(PIXEL), { status: 200, headers: { ...NO_STORE, "content-type": "image/gif", "content-length": String(PIXEL.length) } });
}

export const GET = handle;
export const HEAD = handle;
