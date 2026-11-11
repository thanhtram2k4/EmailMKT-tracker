import { describe, expect, it } from "vitest";
import { decideSend, type GuardInput } from "../../src/lib/sending/guard";
import { createTransport, MockTransport, TransportUnavailableError } from "../../src/lib/sending/transport";

const g = (o: Partial<GuardInput>): GuardInput => ({
  appEnv: "local",
  sendMode: "disabled",
  purpose: "test_send",
  recipients: ["qa@example.com"],
  testRecipientAllowlist: ["qa@example.com"],
  authorizationRef: undefined,
  liveCampaignsEnabled: false,
  ...o,
});

describe("sending guard: customer campaigns", () => {
  it.each(["local", "test", "staging"] as const)("never allows customer campaigns from APP_ENV=%s with a real transport", (appEnv) => {
    for (const sendMode of ["simulator", "allowlist", "live"] as const) {
      const d = decideSend(g({ appEnv, sendMode, purpose: "customer_campaign", authorizationRef: "ref", liveCampaignsEnabled: true }));
      expect(d.allowed && d.transport === "real").toBe(false);
    }
  });

  it("requires production + live + admin enablement", () => {
    expect(decideSend(g({ appEnv: "production", sendMode: "live", purpose: "customer_campaign" }))).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/not been enabled/),
    });
    expect(
      decideSend(g({ appEnv: "production", sendMode: "live", purpose: "customer_campaign", liveCampaignsEnabled: true })),
    ).toEqual({ allowed: true, transport: "real" });
  });

  it("refuses customer campaigns in production when SEND_MODE is not live", () => {
    for (const sendMode of ["disabled", "simulator", "allowlist", "mock"] as const) {
      const d = decideSend(g({ appEnv: "production", sendMode, purpose: "customer_campaign", liveCampaignsEnabled: true, authorizationRef: "r" }));
      expect(d.allowed && d.transport === "real").toBe(false);
    }
  });
});

describe("sending guard: test and integration sends", () => {
  it("disabled refuses everything", () => {
    expect(decideSend(g({ sendMode: "disabled" })).allowed).toBe(false);
  });

  it("mock is allowed outside production and never selects a real transport", () => {
    expect(decideSend(g({ sendMode: "mock", purpose: "customer_campaign" }))).toEqual({ allowed: true, transport: "mock" });
    expect(decideSend(g({ appEnv: "production", sendMode: "mock" })).allowed).toBe(false);
  });

  it("simulator requires authorization and simulator-only recipients", () => {
    const sim = ["success@simulator.amazonses.com", "bounce@SIMULATOR.amazonses.com"];
    expect(decideSend(g({ sendMode: "simulator", recipients: sim })).allowed).toBe(false);
    expect(decideSend(g({ sendMode: "simulator", recipients: sim, authorizationRef: "ok" }))).toEqual({ allowed: true, transport: "real" });
    expect(
      decideSend(g({ sendMode: "simulator", recipients: [...sim, "someone@freemail.example"], authorizationRef: "ok" })).allowed,
    ).toBe(false);
  });

  it("allowlist requires authorization and allowlisted recipients only (case-insensitive)", () => {
    expect(decideSend(g({ sendMode: "allowlist", recipients: ["QA@example.com"], authorizationRef: "ok" }))).toEqual({
      allowed: true,
      transport: "real",
    });
    expect(
      decideSend(g({ sendMode: "allowlist", recipients: ["qa@example.com", "customer@freemail.example"], authorizationRef: "ok" })),
    ).toMatchObject({ allowed: false, reason: expect.stringMatching(/1 recipient/) });
  });

  it("live is production-only, and production test sends are still allowlist-restricted", () => {
    expect(decideSend(g({ appEnv: "staging", sendMode: "live" })).allowed).toBe(false);
    expect(decideSend(g({ appEnv: "production", sendMode: "live", recipients: ["customer@freemail.example"] })).allowed).toBe(false);
    expect(decideSend(g({ appEnv: "production", sendMode: "live" }))).toEqual({ allowed: true, transport: "real" });
  });

  it("refuses an empty recipient list", () => {
    expect(decideSend(g({ sendMode: "mock", recipients: [] })).allowed).toBe(false);
  });
});

describe("transport factory (M1)", () => {
  it("returns the mock transport only when the guard selects mock", async () => {
    const mock = new MockTransport();
    const t = createTransport(g({ sendMode: "mock" }), mock);
    expect(t.name).toBe("mock");
    const r = await t.send({ messageId: "m1", from: "a@example.com", to: "qa@example.com", subject: "s", html: "<p>h</p>", text: "h" });
    expect(r).toEqual({ kind: "accepted", providerMessageId: "mock-m1" });
    expect(mock.sent).toHaveLength(1);
  });

  it("refuses to build any real transport in M1, even when the guard would allow it", () => {
    expect(() => createTransport(g({ sendMode: "simulator", recipients: ["success@simulator.amazonses.com"], authorizationRef: "ok" }))).toThrow(
      TransportUnavailableError,
    );
    expect(() => createTransport(g({ appEnv: "production", sendMode: "live", purpose: "customer_campaign", liveCampaignsEnabled: true }))).toThrow(
      /No real email transport/,
    );
  });

  it("propagates guard refusals", () => {
    expect(() => createTransport(g({ sendMode: "disabled" }))).toThrow(/sending is disabled/);
  });
});
