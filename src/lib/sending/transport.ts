/**
 * Provider-neutral mail transport interface.
 *
 * Decision on record (docs/PLAN.md decisions log, 2026-11-12): customer campaigns use
 * Amazon SES; Gmail API sending is a Phase 2 optional transport. Both implement this interface.
 *
 * `createTransport` is the only way to obtain a transport, and only AFTER the sending guard approves
 * the send. M5: campaign messages use it too. Outside production the guard allows campaign messages
 * only in mock mode, or (as `integration_test`) to SES simulator / allowlisted addresses with an
 * authorization reference; real customer campaigns need production + SEND_MODE=live + the admin toggle.
 */
import { appendFileSync } from "node:fs";
import { decideSend, type GuardInput } from "./guard";
import { SesTransport, type SesTransportOptions } from "./ses-transport";

export type OutboundMessage = {
  /** Our message id (UUID); sent as the SES `msg_id` tag so events can be reconciled. */
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
 *  - rejected:  definitive refusal, nothing was sent;
 *  - retryable: provider confirmed it did NOT accept (e.g. throttling) — safe to retry later;
 *  - unknown:   outcome uncertain (timeout / connection reset after sending) — never auto-retried.
 */
export type SendResult =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "retryable"; code: string; message: string; retryAfterMs?: number }
  | { kind: "unknown"; message: string };

/** Execution-time account check (DESIGN §4.1 step 8, §4.2 "execution-time checks"). */
export type AccountCheck =
  | {
      ok: true;
      sendingEnabled: boolean;
      /** null = no daily limit known (mock). */
      max24h: number | null;
      sentLast24h: number;
      maxPerSecond: number | null;
    }
  | { ok: false; code: "credentials" | "unavailable"; message: string };

export interface MailTransport {
  readonly name: "mock" | "ses" | "gmail";
  send(msg: OutboundMessage): Promise<SendResult>;
  /** Optional: quota / sending-enabled check. */
  account?(): Promise<AccountCheck>;
}

export type MockTransportOptions = {
  /** Scripted account state (tests of quota and credential blocking). */
  account?: () => AccountCheck | Promise<AccountCheck>;
  /** APP_ENV local/test only: append one JSON line per send call (cross-process duplicate checks). */
  logFile?: string;
  /** APP_ENV local/test only: wait this long inside each send (to kill a worker mid-batch). */
  delayMs?: number;
};

/** In-memory transport for local development and automated tests. Never uses the network. */
export class MockTransport implements MailTransport {
  readonly name = "mock" as const;
  readonly sent: OutboundMessage[] = [];
  /** Every send call, including ones that did not end as accepted. */
  readonly calls: OutboundMessage[] = [];
  constructor(
    private script: (msg: OutboundMessage) => SendResult | Promise<SendResult> = defaultMockOutcome,
    private readonly opts: MockTransportOptions = {},
  ) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    this.calls.push(msg);
    if (this.opts.logFile) {
      appendFileSync(this.opts.logFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, messageId: msg.messageId, attempt: msg.tags?.attempt ?? null }) + "\n");
    }
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    const r = await this.script(msg);
    if (r.kind === "accepted") this.sent.push(msg);
    return r;
  }
  async account(): Promise<AccountCheck> {
    return this.opts.account ? this.opts.account() : { ok: true, sendingEnabled: true, max24h: null, sentLast24h: 0, maxPerSecond: null };
  }
}

function defaultMockOutcome(msg: OutboundMessage): SendResult {
  // Campaign resends carry an attempt tag, so each attempt gets its own provider id.
  return { kind: "accepted", providerMessageId: msg.tags?.attempt ? `mock-${msg.messageId}-${msg.tags.attempt}` : `mock-${msg.messageId}` };
}

export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

/**
 * Build the transport for a send, after the guard has approved it.
 * Throws if the guard denies or if a real transport is needed but SES is not configured.
 */
export function createTransport(
  input: GuardInput,
  opts: MockTransport | { mock?: MockTransport; ses?: SesTransportOptions | null } = {},
): MailTransport {
  const o = opts instanceof MockTransport ? { mock: opts } : opts;
  const d = decideSend(input);
  if (!d.allowed) throw new TransportUnavailableError(`Send refused: ${d.reason}`);
  if (d.transport === "mock") return o.mock ?? new MockTransport();
  if (!o.ses?.from) {
    throw new TransportUnavailableError("No real email transport is configured: set SES_FROM_ADDRESS (and AWS credentials) for SES sends.");
  }
  return new SesTransport(o.ses);
}
