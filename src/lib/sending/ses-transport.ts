/**
 * Amazon SES v2 transport (M4: test sends only).
 *
 * Safety:
 *  - It is only ever constructed by `createTransport` AFTER the sending guard has approved a real
 *    send (SEND_MODE=simulator|allowlist with SEND_AUTHORIZATION_REF, or production live).
 *  - The SDK's own retries are disabled (maxAttempts 1). A retried request after a timeout could
 *    deliver a second copy; uncertain outcomes are reported as `unknown` and never retried here.
 *  - Credentials come from the AWS SDK default chain (normally AWS_PROFILE → ~/.aws/credentials),
 *    never from this repository, the database, or logs.
 *  - "accepted" means SES accepted the message for sending. It is NOT proof of inbox delivery.
 */
import { GetAccountCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { MailTransport, OutboundMessage, SendResult } from "./transport";

/** The subset of the SDK client we use; tests inject a fake (no network). */
export type SesClientLike = {
  send(command: SendEmailCommand | GetAccountCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
};

export type SesTransportOptions = {
  region: string;
  from: string;
  configurationSet?: string;
  timeoutMs: number;
  client?: SesClientLike;
};

export function makeSesClient(region: string): SesClientLike {
  return new SESv2Client({ region, maxAttempts: 1 }) as unknown as SesClientLike;
}

/** Tag values may contain only ASCII letters, digits, _ - . @ (SES rule). */
const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 256);

/** Errors raised before any request left this machine: definitely not sent. */
const PRE_REQUEST_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "CredentialsProviderError", "ERR_INVALID_URL"]);
/** Errors after which the request may have reached SES: outcome unknown. */
const UNCERTAIN_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT", "AbortError", "TimeoutError", "RequestTimeout", "RequestTimeoutException"]);

type SdkError = { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown };

/** Map an SES/SDK error to our outcome taxonomy. Exported for unit tests. */
export function classifySesError(e: unknown): SendResult {
  const err = (e ?? {}) as SdkError;
  const name = err.name ?? "Error";
  const code = err.code ?? name;
  const message = (err.message ?? String(e)).slice(0, 500);
  const status = err.$metadata?.httpStatusCode;

  if (UNCERTAIN_CODES.has(code) || UNCERTAIN_CODES.has(name)) return { kind: "unknown", message: `${name}: ${message}` };
  if (PRE_REQUEST_CODES.has(code) || PRE_REQUEST_CODES.has(name) || /could not load credentials/i.test(message)) {
    // Nothing was sent. Missing credentials need an operator; they are reported as a refusal.
    if (name === "CredentialsProviderError" || /credentials/i.test(message)) return { kind: "rejected", code: "credentials", message };
    return { kind: "retryable", code, message };
  }
  switch (name) {
    case "TooManyRequestsException":
    case "LimitExceededException":
    case "ThrottlingException":
      return { kind: "retryable", code: name, message };
    case "MessageRejected":
    case "MailFromDomainNotVerifiedException":
    case "AccountSuspendedException":
    case "SendingPausedException":
    case "BadRequestException":
    case "NotFoundException":
      return { kind: "rejected", code: name, message };
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "AccessDeniedException":
    case "ExpiredTokenException":
      return { kind: "rejected", code: "credentials", message: `${name}: ${message}` };
  }
  // A 4xx response is a definitive refusal; a 5xx (or no response) may or may not have been processed.
  if (status && status >= 400 && status < 500) return { kind: "rejected", code: name, message };
  return { kind: "unknown", message: `${name}: ${message}` };
}

export class SesTransport implements MailTransport {
  readonly name = "ses" as const;
  private readonly client: SesClientLike;
  constructor(private readonly o: SesTransportOptions) {
    this.client = o.client ?? makeSesClient(o.region);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const headers = Object.entries(msg.headers ?? {}).map(([Name, Value]) => ({ Name, Value }));
    const cmd = new SendEmailCommand({
      FromEmailAddress: this.o.from,
      Destination: { ToAddresses: [msg.to] },
      ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: { Html: { Data: msg.html, Charset: "UTF-8" }, Text: { Data: msg.text, Charset: "UTF-8" } },
          Headers: headers.length ? headers : undefined,
        },
      },
      EmailTags: [
        { Name: "msg_id", Value: tagValue(msg.messageId) },
        ...Object.entries(msg.tags ?? {}).map(([Name, Value]) => ({ Name: tagValue(Name), Value: tagValue(Value) })),
      ],
      ConfigurationSetName: this.o.configurationSet || undefined,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs);
    try {
      const out = (await this.client.send(cmd, { abortSignal: ac.signal })) as { MessageId?: string };
      if (!out?.MessageId) return { kind: "unknown", message: "SES returned no MessageId" };
      return { kind: "accepted", providerMessageId: out.MessageId };
    } catch (e) {
      if (ac.signal.aborted) return { kind: "unknown", message: `no response from SES within ${this.o.timeoutMs} ms` };
      return classifySesError(e);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type SesAccountInfo = { productionAccess: boolean; sendingEnabled: boolean; max24h?: number; sentLast24h?: number; maxPerSecond?: number; enforcementStatus?: string };

/** Read-only account check (GetAccount). Only called when an admin presses the button. */
export async function getSesAccount(client: SesClientLike, timeoutMs: number): Promise<SesAccountInfo> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = (await client.send(new GetAccountCommand({}), { abortSignal: ac.signal })) as {
      ProductionAccessEnabled?: boolean;
      SendingEnabled?: boolean;
      EnforcementStatus?: string;
      SendQuota?: { Max24HourSend?: number; SentLast24Hours?: number; MaxSendRate?: number };
    };
    return {
      productionAccess: Boolean(r.ProductionAccessEnabled),
      sendingEnabled: Boolean(r.SendingEnabled),
      enforcementStatus: r.EnforcementStatus,
      max24h: r.SendQuota?.Max24HourSend,
      sentLast24h: r.SendQuota?.SentLast24Hours,
      maxPerSecond: r.SendQuota?.MaxSendRate,
    };
  } finally {
    clearTimeout(timer);
  }
}
