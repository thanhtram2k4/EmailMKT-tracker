/**
 * R-TS-06 / R-TS-07 (unit, MOCK): SES outcome mapping and message shape, with a fake client.
 * No network: every test injects `client`.
 */
import { describe, expect, it } from "vitest";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { classifySesError, SesTransport, type SesClientLike } from "../../src/lib/sending/ses-transport";
import { parseTestRecipients } from "../../src/lib/sending/test-send";

const msg = { messageId: "0b6f6f3e-0000-4000-8000-000000000001", from: "x", to: "qa@example.com", subject: "[TEST] Chào", html: "<p>h</p>", text: "h", headers: { "X-EMT-Purpose": "test-send" }, tags: { purpose: "test_send" } };
const err = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${name} happened`), { name, ...extra });

function fake(impl: (cmd: SendEmailCommand, o?: { abortSignal?: AbortSignal }) => Promise<unknown>) {
  const calls: SendEmailCommand[] = [];
  const client: SesClientLike = {
    send: async (cmd, o) => {
      calls.push(cmd as SendEmailCommand);
      return impl(cmd as SendEmailCommand, o);
    },
  };
  return { client, calls };
}

describe("SES transport", () => {
  it("R-TS-07: sends one message with UTF-8 content, our headers and tags; accepted ≠ delivered", async () => {
    const f = fake(async () => ({ MessageId: "ses-123" }));
    const t = new SesTransport({ region: "ap-southeast-1", from: "QA <qa-from@example.com>", configurationSet: "cs", timeoutMs: 1000, client: f.client });
    expect(await t.send(msg)).toEqual({ kind: "accepted", providerMessageId: "ses-123" });
    expect(f.calls).toHaveLength(1);
    const input = f.calls[0].input;
    expect(input.FromEmailAddress).toBe("QA <qa-from@example.com>");
    expect(input.Destination?.ToAddresses).toEqual(["qa@example.com"]);
    expect(input.Content?.Simple?.Subject).toEqual({ Data: "[TEST] Chào", Charset: "UTF-8" });
    expect(input.Content?.Simple?.Headers).toEqual([{ Name: "X-EMT-Purpose", Value: "test-send" }]);
    expect(input.EmailTags).toEqual([
      { Name: "msg_id", Value: msg.messageId },
      { Name: "purpose", Value: "test_send" },
    ]);
    expect(input.ConfigurationSetName).toBe("cs");
  });

  it("R-TS-05: no response within the timeout → unknown, and the transport does not retry", async () => {
    const f = fake((_c, o) => new Promise((_res, rej) => o?.abortSignal?.addEventListener("abort", () => rej(err("AbortError")))));
    const t = new SesTransport({ region: "ap-southeast-1", from: "qa-from@example.com", timeoutMs: 1000, client: f.client });
    const r = await t.send(msg);
    expect(r.kind).toBe("unknown");
    expect(f.calls).toHaveLength(1);
  }, 5000);

  it("R-TS-06: maps SES errors to rejected / retryable / unknown", () => {
    expect(classifySesError(err("MessageRejected"))).toMatchObject({ kind: "rejected", code: "MessageRejected" });
    expect(classifySesError(err("MailFromDomainNotVerifiedException"))).toMatchObject({ kind: "rejected" });
    expect(classifySesError(err("AccountSuspendedException"))).toMatchObject({ kind: "rejected" });
    expect(classifySesError(err("SendingPausedException"))).toMatchObject({ kind: "rejected" });
    expect(classifySesError(err("TooManyRequestsException"))).toMatchObject({ kind: "retryable" });
    expect(classifySesError(err("LimitExceededException"))).toMatchObject({ kind: "retryable" });
    // Credentials problems: nothing sent, needs an operator.
    expect(classifySesError(err("CredentialsProviderError"))).toMatchObject({ kind: "rejected", code: "credentials" });
    expect(classifySesError(err("UnrecognizedClientException", { $metadata: { httpStatusCode: 403 } }))).toMatchObject({ kind: "rejected", code: "credentials" });
    // Connection reset or a 5xx: the request may have been processed → unknown, never retried.
    expect(classifySesError(err("Error", { code: "ECONNRESET" })).kind).toBe("unknown");
    expect(classifySesError(err("InternalFailure", { $metadata: { httpStatusCode: 500 } })).kind).toBe("unknown");
    // DNS failure: the request never left → not accepted, safe to report as retryable (still not auto-retried).
    expect(classifySesError(err("Error", { code: "ENOTFOUND" })).kind).toBe("retryable");
  });

  it("treats a response without MessageId as unknown", async () => {
    const t = new SesTransport({ region: "ap-southeast-1", from: "qa-from@example.com", timeoutMs: 1000, client: fake(async () => ({})).client });
    expect((await t.send(msg)).kind).toBe("unknown");
  });
});

describe("test recipient parsing", () => {
  it("splits, normalizes, de-duplicates and reports invalid addresses", () => {
    expect(parseTestRecipients(" QA@Example.com, qa@example.com;\nother@example.org ")).toEqual({ ok: ["qa@example.com", "other@example.org"], invalid: [] });
    expect(parseTestRecipients("qa@example.com, not-an-email").invalid).toEqual(["not-an-email"]);
  });
});
