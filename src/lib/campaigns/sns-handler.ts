/**
 * HTTP handling for POST /api/ses-events (kept out of the route file so integration tests can call it
 * with an injected certificate resolver). Returns a status code and a short body; never echoes input.
 */
import { readFileSync } from "node:fs";
import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { getLogger } from "../logger";
import { ingestSesEvent } from "./events";
import { httpsCertResolver, parseSnsBody, verifySnsMessage, type CertResolver } from "./sns";

export type SnsHandlerConfig = Pick<AppConfig, "APP_ENV" | "SES_EVENTS_TOPIC_ARN" | "SNS_TEST_PUBLIC_KEY_FILE">;

const prodResolver = httpsCertResolver();

/** Test-only: the configured public key replaces the AWS certificate download (APP_ENV local/test). */
export function resolverFor(cfg: SnsHandlerConfig): CertResolver {
  if (cfg.SNS_TEST_PUBLIC_KEY_FILE && (cfg.APP_ENV === "local" || cfg.APP_ENV === "test")) {
    const pem = readFileSync(cfg.SNS_TEST_PUBLIC_KEY_FILE, "utf8");
    return async () => pem;
  }
  return prodResolver;
}

export async function handleSnsPost(
  db: Db,
  cfg: SnsHandlerConfig,
  body: string,
  o: { messageTypeHeader?: string | null; correlationId?: string; resolveCert?: CertResolver; now?: Date } = {},
): Promise<{ status: number; body: string }> {
  const log = getLogger().child({ task: "ses_events_endpoint", request_id: o.correlationId });
  if (!cfg.SES_EVENTS_TOPIC_ARN) return { status: 503, body: "event ingestion is not configured" };
  if (body.length > 256 * 1024) return { status: 413, body: "too large" };
  const m = parseSnsBody(body);
  if (!m) return { status: 400, body: "not an SNS message" };
  if (o.messageTypeHeader && o.messageTypeHeader !== m.Type) return { status: 400, body: "message type mismatch" };

  const v = await verifySnsMessage(m, { expectedTopicArn: cfg.SES_EVENTS_TOPIC_ARN, resolveCert: o.resolveCert ?? resolverFor(cfg), now: o.now });
  if (!v.ok) {
    log.warn({ reason: v.reason }, "SNS message rejected");
    await writeAudit(db, { actor: "anonymous", action: "ses_events.rejected", entityType: "sns", entityId: m.MessageId.slice(0, 100), after: { reason: v.reason }, correlationId: o.correlationId });
    return { status: 403, body: "verification failed" };
  }

  if (m.Type !== "Notification") {
    // Recorded only. Confirming a subscription is a manual step after deployment is authorized.
    let host: string | null = null;
    try {
      host = m.SubscribeURL ? new URL(m.SubscribeURL).host : null;
    } catch {
      host = null;
    }
    await writeAudit(db, { actor: "system:sns", action: `ses_events.${m.Type}`, entityType: "sns", entityId: m.TopicArn, after: { subscribeHost: host }, correlationId: o.correlationId });
    log.warn({ type: m.Type }, "SNS subscription message recorded (not confirmed automatically)");
    return { status: 200, body: "recorded" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(m.Message);
  } catch {
    return { status: 200, body: "ignored (not JSON)" };
  }
  const r = await ingestSesEvent(db, m.MessageId, payload, { correlationId: o.correlationId });
  return { status: 200, body: r.status };
}
