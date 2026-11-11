import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/lib/config";

const base = {
  APP_ENV: "local",
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
  APP_BASE_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  ALLOWED_EMAIL_DOMAINS: "Example.com, other.vn",
};
const prod = {
  ...base,
  APP_ENV: "production",
  APP_BASE_URL: "https://app.example.com",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  // Required in production since M2 (encrypts the stored Notion token).
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
};

function issues(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
}

describe("config safety rules", () => {
  it("defaults SEND_MODE to disabled and normalizes domains", () => {
    const c = parseConfig(base);
    expect(c.SEND_MODE).toBe("disabled");
    expect(c.ALLOWED_EMAIL_DOMAINS).toEqual(["example.com", "other.vn"]);
    expect(c.googleEnabled).toBe(false);
  });

  it.each(["local", "test", "staging"])("rejects SEND_MODE=live when APP_ENV=%s", (env) => {
    const extra = env === "staging" ? { APP_BASE_URL: "https://s.example.com", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" } : {};
    expect(issues({ ...base, ...extra, APP_ENV: env, SEND_MODE: "live" }).join()).toMatch(/SEND_MODE=live is forbidden/);
  });

  it("accepts SEND_MODE=live only in production", () => {
    expect(issues({ ...prod, SEND_MODE: "live" })).toEqual([]);
  });

  it("rejects SEND_MODE=mock in production", () => {
    expect(issues({ ...prod, SEND_MODE: "mock" }).join()).toMatch(/mock is not allowed in production/);
  });

  it.each(["simulator", "allowlist"])("requires SEND_AUTHORIZATION_REF for SEND_MODE=%s", (mode) => {
    expect(issues({ ...base, SEND_MODE: mode, TEST_RECIPIENT_ALLOWLIST: "qa@example.com" }).join()).toMatch(
      /requires SEND_AUTHORIZATION_REF/,
    );
    expect(
      issues({ ...base, SEND_MODE: mode, TEST_RECIPIENT_ALLOWLIST: "qa@example.com", SEND_AUTHORIZATION_REF: "approved 2026-11-12" }),
    ).toEqual([]);
  });

  it("requires a non-empty allowlist for SEND_MODE=allowlist", () => {
    expect(issues({ ...base, SEND_MODE: "allowlist", SEND_AUTHORIZATION_REF: "x" }).join()).toMatch(/TEST_RECIPIENT_ALLOWLIST/);
  });

  it.each(["staging", "production"])("refuses the dev sign-in when APP_ENV=%s", (env) => {
    const e = env === "staging" ? { ...prod, APP_ENV: "staging" } : prod;
    expect(issues({ ...e, DEV_LOGIN_ENABLED: "true" }).join()).toMatch(/dev sign-in/);
  });

  it("requires Google OAuth and https in staging/production", () => {
    const i = issues({ ...base, APP_ENV: "production" }).join();
    expect(i).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required/);
    expect(i).toMatch(/https/);
  });

  it("rejects short secrets and missing domains", () => {
    const i = issues({ ...base, BETTER_AUTH_SECRET: "short", ALLOWED_EMAIL_DOMAINS: "" }).join();
    expect(i).toMatch(/BETTER_AUTH_SECRET/);
    expect(i).toMatch(/ALLOWED_EMAIL_DOMAINS/);
  });
});

describe("config: Notion access rules", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  it("defaults to NOTION_MODE=disabled with no base URL", () => {
    const c = parseConfig(base);
    expect(c.NOTION_MODE).toBe("disabled");
    expect(c.notionBaseUrl).toBeNull();
  });
  it("mock mode requires an encryption key and a loopback base URL", () => {
    expect(issues({ ...base, NOTION_MODE: "mock" }).join()).toMatch(/APP_ENCRYPTION_KEY is required/);
    expect(parseConfig({ ...base, NOTION_MODE: "mock", APP_ENCRYPTION_KEY: key }).notionBaseUrl).toBe("http://127.0.0.1:4010");
    expect(issues({ ...base, NOTION_MODE: "mock", APP_ENCRYPTION_KEY: key, NOTION_API_BASE_URL: "https://api.notion.com" }).join()).toMatch(/loopback/);
  });
  it("mock mode is refused in production", () => {
    expect(issues({ ...prod, NOTION_MODE: "mock", APP_ENCRYPTION_KEY: key }).join()).toMatch(/mock is not allowed in production/);
  });
  it("live mode requires NOTION_AUTHORIZATION_REF and the official API host", () => {
    expect(issues({ ...base, NOTION_MODE: "live", APP_ENCRYPTION_KEY: key }).join()).toMatch(/NOTION_AUTHORIZATION_REF/);
    expect(issues({ ...base, NOTION_MODE: "live", APP_ENCRYPTION_KEY: key, NOTION_AUTHORIZATION_REF: "x", NOTION_API_BASE_URL: "http://127.0.0.1:4010" }).join()).toMatch(/must use https:\/\/api.notion.com/);
    const c = parseConfig({ ...base, NOTION_MODE: "live", APP_ENCRYPTION_KEY: key, NOTION_AUTHORIZATION_REF: "approved test DB 2026-11-12" });
    expect(c.notionBaseUrl).toBe("https://api.notion.com");
  });
  it("rejects a malformed encryption key and requires one in staging/production", () => {
    expect(issues({ ...base, APP_ENCRYPTION_KEY: "short" }).join()).toMatch(/32 random bytes/);
    expect(issues({ ...prod, APP_ENCRYPTION_KEY: undefined }).join()).toMatch(/APP_ENCRYPTION_KEY is required/);
  });
});

describe("config: blank values", () => {
  it("treats KEY= (blank) as unset, as in .env.example (regression found by the M2 dev-flow check)", () => {
    const c = parseConfig({ ...base, NOTION_MODE: "mock", APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"), NOTION_API_BASE_URL: "", NOTION_AUTHORIZATION_REF: "", SEND_AUTHORIZATION_REF: " " });
    expect(c.notionBaseUrl).toBe("http://127.0.0.1:4010");
    expect(c.NOTION_AUTHORIZATION_REF).toBeUndefined();
  });
  it("parses the committed .env.example (with a generated key) without errors", async () => {
    const fs = await import("node:fs");
    const env = Object.fromEntries([...fs.readFileSync(".env.example", "utf8").matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    expect(() => parseConfig({ ...env, BETTER_AUTH_SECRET: "x".repeat(40) })).not.toThrow();
    expect(() => parseConfig({ ...env, BETTER_AUTH_SECRET: "x".repeat(40), NOTION_MODE: "mock", APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64url") })).not.toThrow();
  });
});
