/**
 * Provider-neutral mail transport interface.
 *
 * Decision on record (docs/PLAN.md decisions log, 2026-11-12): customer campaigns use
 * Amazon SES; Gmail API sending is a Phase 2 optional transport. Both implement this interface.
 *
 * M4: an SES transport exists for TEST SENDS only. `createTransport` builds it only when the guard
 * approves a real send AND SES is configured. Customer campaigns are still refused (no send engine
 * until M5). Building a transport never bypasses the guard.
 */
import { decideSend, type GuardInput } from "./guard";
import { SesTransport, type SesTransportOptions } from "./ses-transport";

export type OutboundMessage = {
  /** Our message id (UUID); becomes the SES `msg_id` tag / Message-ID local part from M5. */
  messageId: string;
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
};

/**
 * Outcome taxonomy used by the M5 send engine:
 *  - accepted:  the provider accepted the message (NOT proof of delivery);
 *  - rejected:  definitive refusal, safe to mark failed_permanent;
 *  - retryable: provider confirmed it did NOT accept (e.g. throttling) — safe to retry later;
 *  - unknown:   outcome uncertain (timeout / connection reset after sending) — never auto-retried.
 */
export type SendResult =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "retryable"; code: string; message: string; retryAfterMs?: number }
  | { kind: "unknown"; message: string };

export interface MailTransport {
  readonly name: "mock" | "ses" | "gmail";
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** In-memory transport for local development and automated tests. Never uses the network. */
export class MockTransport implements MailTransport {
  readonly name = "mock" as const;
  readonly sent: OutboundMessage[] = [];
  /** Optional scripted outcomes per recipient, for tests of the M5 engine. */
  constructor(private script: (msg: OutboundMessage) => SendResult | Promise<SendResult> = defaultMockOutcome) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    const r = await this.script(msg);
    if (r.kind === "accepted") this.sent.push(msg);
    return r;
  }
}

function defaultMockOutcome(msg: OutboundMessage): SendResult {
  return { kind: "accepted", providerMessageId: `mock-${msg.messageId}` };
}

export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

/**
 * Build the transport for a send, after the guard has approved it.
 * Throws if the guard denies, if SES is not configured, or for customer campaigns (no engine until M5).
 */
export function createTransport(
  input: GuardInput,
  opts: MockTransport | { mock?: MockTransport; ses?: SesTransportOptions | null } = {},
): MailTransport {
  const o = opts instanceof MockTransport ? { mock: opts } : opts;
  const d = decideSend(input);
  if (!d.allowed) throw new TransportUnavailableError(`Send refused: ${d.reason}`);
  if (d.transport === "mock") return o.mock ?? new MockTransport();
  if (input.purpose === "customer_campaign") {
    throw new TransportUnavailableError("Customer campaign sending is not implemented yet (M5) and requires separate authorization.");
  }
  if (!o.ses?.from) {
    throw new TransportUnavailableError("No real email transport is configured: set SES_FROM_ADDRESS (and AWS credentials) for SES test sends.");
  }
  return new SesTransport(o.ses);
}
