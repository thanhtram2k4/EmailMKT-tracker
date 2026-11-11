/**
 * Provider-neutral mail transport interface.
 *
 * Decision on record (docs/PLAN.md decisions log, 2026-11-12): customer campaigns use
 * Amazon SES; Gmail API sending is a Phase 2 optional transport. Both will implement
 * this interface. M1 ships ONLY the mock transport — no network-capable transport exists
 * yet, and `createTransport` refuses to build one.
 */
import { decideSend, type GuardInput } from "./guard";

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
 * Throws if the guard denies, or if a real transport is required (none exists in M1).
 */
export function createTransport(input: GuardInput, mock: MockTransport = new MockTransport()): MailTransport {
  const d = decideSend(input);
  if (!d.allowed) throw new TransportUnavailableError(`Send refused: ${d.reason}`);
  if (d.transport === "mock") return mock;
  throw new TransportUnavailableError(
    "No real email transport is implemented (M1). SES integration is scheduled for M4/M5 and requires separate authorization.",
  );
}
