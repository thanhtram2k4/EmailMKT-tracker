/**
 * Public SNS endpoint for SES events (configuration set → SNS → HTTPS). Every message is verified
 * (topic, certificate host, signature, timestamp) before anything is stored; see lib/campaigns/sns.ts.
 * Unconfigured (no SES_EVENTS_TOPIC_ARN) it refuses everything with 503.
 */
import { getConfig } from "../../../lib/config";
import { getDb } from "../../../lib/db/client";
import { handleSnsPost } from "../../../lib/campaigns/sns-handler";
import { limited } from "../../../lib/campaigns/tracking-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tooMany = limited(req, "ses_events");
  if (tooMany) return tooMany;
  const body = await req.text();
  const r = await handleSnsPost(getDb(), getConfig(), body, {
    messageTypeHeader: req.headers.get("x-amz-sns-message-type"),
    correlationId: req.headers.get("x-request-id") ?? undefined,
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
