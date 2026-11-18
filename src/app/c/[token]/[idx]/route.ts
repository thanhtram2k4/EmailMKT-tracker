/**
 * Public click redirect: GET|HEAD /c/<token>/<linkIdx> (DESIGN §4.3).
 * Redirects ONLY to the URL stored at that index in the message's snapshot link table. Nothing from
 * the query string is ever used as a destination: an unknown token or index is a 404, not a redirect.
 */
import { getConfig } from "../../../../lib/config";
import { getDb } from "../../../../lib/db/client";
import { recordClick } from "../../../../lib/campaigns/tracking";
import { limited, NO_STORE, notFound, requestInfo } from "../../../../lib/campaigns/tracking-http";

export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: { params: Promise<{ token: string; idx: string }> }) {
  const tooMany = limited(req, "click");
  if (tooMany) return tooMany;
  const { token, idx } = await ctx.params;
  const url = await recordClick(getDb(), token, idx, requestInfo(req), getConfig().BETTER_AUTH_SECRET);
  if (!url) return notFound();
  return new Response(null, { status: 302, headers: { ...NO_STORE, location: url } });
}

export const GET = handle;
export const HEAD = handle;
