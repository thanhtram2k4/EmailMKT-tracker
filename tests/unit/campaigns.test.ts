import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lib/config";
import { RateLimiter } from "../../src/lib/campaigns/dispatcher";
import { extractLinks, hasUnsubscribeLink, renderMessage, unsubscribeHeaders } from "../../src/lib/campaigns/render";
import { isValidCertUrl, parseSnsBody, stringToSign, type SnsMessage } from "../../src/lib/campaigns/sns";
import { campaignGuard } from "../../src/lib/campaigns/service";
import { crontabFor } from "../../src/worker/tasks";

describe("RateLimiter (controlled clock)", () => {
  function fake(rate: number) {
    let t = 0;
    const sleeps: number[] = [];
    const lim = new RateLimiter(
      rate,
      () => t,
      async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    );
    return { lim, sleeps, now: () => t };
  }
  it("paces calls at the configured rate with burst 1", async () => {
    const { lim, now } = fake(5);
    for (let i = 0; i < 6; i++) await lim.take();
    expect(now()).toBe(1000); // 6 calls at 5/s: the 6th starts at t=1000 ms
  });
  it("a throttling penalty delays the next slot", async () => {
    const { lim, sleeps } = fake(10);
    await lim.take();
    lim.penalize(2000);
    await lim.take();
    expect(sleeps).toEqual([2000]);
  });
});

describe("SNS helpers", () => {
  it("accepts only https SNS certificate URLs ending in .pem", () => {
    expect(isValidCertUrl("https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-1.pem")).toBe(true);
    expect(isValidCertUrl("https://sns.cn-north-1.amazonaws.com.cn/x.pem")).toBe(true);
    for (const u of [
      "http://sns.ap-southeast-1.amazonaws.com/x.pem",
      "https://sns.ap-southeast-1.amazonaws.com.evil.example/x.pem",
      "https://evil.example/sns.ap-southeast-1.amazonaws.com/x.pem",
      "https://sns.ap-southeast-1.amazonaws.com:8443/x.pem",
      "https://user@sns.ap-southeast-1.amazonaws.com/x.pem",
      "https://sns.ap-southeast-1.amazonaws.com/x.pem.txt",
      "not a url",
    ]) {
      expect(isValidCertUrl(u), u).toBe(false);
    }
  });
  it("builds the canonical string (Subject only when present; confirmation keys)", () => {
    const base: SnsMessage = { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "hi", Timestamp: "ts", SignatureVersion: "2", Signature: "s", SigningCertURL: "u" };
    expect(stringToSign(base)).toBe("Message\nhi\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n");
    expect(stringToSign({ ...base, Subject: "S" })).toBe("Message\nhi\nMessageId\nm\nSubject\nS\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n");
    expect(stringToSign({ ...base, Type: "SubscriptionConfirmation", SubscribeURL: "su", Token: "tk" })).toBe(
      "Message\nhi\nMessageId\nm\nSubscribeURL\nsu\nTimestamp\nts\nToken\ntk\nTopicArn\nt\nType\nSubscriptionConfirmation\n",
    );
  });
  it("rejects malformed bodies", () => {
    expect(parseSnsBody("{")).toBeNull();
    expect(parseSnsBody(JSON.stringify({ Type: "Notification" }))).toBeNull();
    expect(parseSnsBody(JSON.stringify({ Type: "SubscriptionConfirmation", MessageId: "m", TopicArn: "t", Message: "x", Timestamp: "t", SignatureVersion: "2", Signature: "s", SigningCertURL: "u" }))).toBeNull();
  });
});

describe("campaign rendering", () => {
  const snap = { subjectTemplate: '[QC] Chào {{ greeting_name | default: "bạn" }}', html: '<p>{{ greeting_name | default: "Quý khách" }}</p><a href="{{ unsubscribe_url }}">Hủy</a>', plainText: "Xin chào" };
  it("uses frozen values and the opaque-token unsubscribe URL; adds an opt-out line to the plain text", () => {
    const r = renderMessage(snap, { full_name: "A", greeting_name: null, company: null, email: "a@example.com" }, "TOKEN_abc-123456789", "https://t.example");
    expect(r.problems).toEqual([]);
    expect(r.subject).toBe("[QC] Chào bạn");
    expect(r.html).toBe('<p>Quý khách</p><a href="https://t.example/u/TOKEN_abc-123456789">Hủy</a>');
    expect(r.text).toContain("https://t.example/u/TOKEN_abc-123456789");
    expect(unsubscribeHeaders(r.unsubscribeUrl)).toEqual({ "List-Unsubscribe": "<https://t.example/u/TOKEN_abc-123456789>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
  it("detects the unsubscribe link (also inside MSO conditionals) and only real http(s) links", () => {
    expect(hasUnsubscribeLink(snap.html)).toBe(true);
    expect(hasUnsubscribeLink("<p>{{ unsubscribe_url }}</p>")).toBe(false);
    expect(hasUnsubscribeLink('<!--[if mso]><a href="{{ unsubscribe_url }}">x</a><![endif]-->')).toBe(true);
    expect(extractLinks('<a href="https://a.example/x">A</a><a href="mailto:x@example.com">m</a><a href="{{ unsubscribe_url }}">u</a><a href="http://b.example"><img alt="Logo"></a>')).toEqual([
      { idx: 0, url: "https://a.example/x", label: "A" },
      { idx: 1, url: "http://b.example", label: "Logo" },
    ]);
  });
  it("reports a missing value without fallback as a problem (never sent silently)", () => {
    const r = renderMessage({ ...snap, subjectTemplate: "Hi {{ greeting_name }}" }, { full_name: null, greeting_name: null, company: null, email: "a@example.com" }, "TOKEN_abc-123456789", "https://t.example");
    expect(r.problems.join()).toMatch(/greeting_name: no value/);
  });
});

describe("campaign guard (outside production campaigns are integration tests only)", () => {
  const base = { APP_ENV: "local" as const, TEST_RECIPIENT_ALLOWLIST: ["qa@example.com"], SEND_AUTHORIZATION_REF: "REF", SES_FROM_ADDRESS: "qa@example.com" };
  it("mock is allowed locally; disabled refuses; simulator/allowlist only for those addresses; production needs the admin toggle", () => {
    expect(campaignGuard({ ...base, SEND_MODE: "mock" }, { liveCampaignsEnabled: false }, ["anyone@example.org"])).toEqual({ allowed: true, transport: "mock" });
    expect(campaignGuard({ ...base, SEND_MODE: "disabled" }, { liveCampaignsEnabled: false }, ["qa@example.com"]).allowed).toBe(false);
    expect(campaignGuard({ ...base, SEND_MODE: "allowlist" }, { liveCampaignsEnabled: false }, ["qa@example.com"]).allowed).toBe(true);
    expect(campaignGuard({ ...base, SEND_MODE: "allowlist" }, { liveCampaignsEnabled: false }, ["customer@example.org"]).allowed).toBe(false);
    expect(campaignGuard({ ...base, SEND_MODE: "simulator" }, { liveCampaignsEnabled: false }, ["success@simulator.amazonses.com"]).allowed).toBe(true);
    expect(campaignGuard({ ...base, APP_ENV: "staging", SEND_MODE: "simulator" }, { liveCampaignsEnabled: true }, ["customer@example.org"]).allowed).toBe(false);
    expect(campaignGuard({ ...base, APP_ENV: "production", SEND_MODE: "live" }, { liveCampaignsEnabled: false }, ["customer@example.org"])).toMatchObject({ allowed: false });
    expect(campaignGuard({ ...base, APP_ENV: "production", SEND_MODE: "live" }, { liveCampaignsEnabled: true }, ["customer@example.org"])).toEqual({ allowed: true, transport: "real" });
  });
});

describe("worker schedules", () => {
  // Regression for a defect found in M5: send maintenance was registered only when Notion was enabled.
  it("registers send maintenance independently of the CRM schedules", () => {
    const sendOnly = crontabFor({ crm: false, sending: true });
    expect(sendOnly).toContain("test_send_reaper");
    expect(sendOnly).toContain("campaign_maintenance");
    expect(sendOnly).not.toContain("crm_sync");
    expect(crontabFor({ crm: true, sending: false })).not.toContain("campaign_maintenance");
  });
});

describe("M5 config", () => {
  const env = (o: Record<string, string>) => ({
    APP_ENV: "local",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    APP_BASE_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "x".repeat(40),
    ALLOWED_EMAIL_DOMAINS: "example.com",
    ...o,
  });
  const staging = { APP_ENV: "staging", APP_BASE_URL: "https://staging.example.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url") };
  it("test-only hooks are refused in staging/production", () => {
    for (const [k, v] of [
      ["SNS_TEST_PUBLIC_KEY_FILE", "x.pem"],
      ["MOCK_TRANSPORT_LOG", "x.jsonl"],
      ["MOCK_SEND_DELAY_MS", "100"],
    ]) {
      expect(() => parseConfig(env({ ...staging, [k]: v })), k).toThrow(new RegExp(k));
      expect(() => parseConfig(env({ [k]: v }))).not.toThrow();
    }
  });
  it("tracking base URL defaults to the app URL; the topic must be an SNS ARN", () => {
    expect(parseConfig(env({})).trackingBaseUrl).toBe("http://localhost:3000");
    expect(parseConfig(env({ TRACKING_BASE_URL: "https://t.example.com/" })).trackingBaseUrl).toBe("https://t.example.com");
    expect(() => parseConfig(env({ SES_EVENTS_TOPIC_ARN: "not-an-arn" }))).toThrow(/SNS topic ARN/);
    expect(parseConfig(env({ SES_EVENTS_TOPIC_ARN: "arn:aws:sns:ap-southeast-1:123456789012:ses-events" })).SES_EVENTS_TOPIC_ARN).toContain("ses-events");
  });
});
