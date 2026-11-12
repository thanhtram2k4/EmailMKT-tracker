/**
 * Validated runtime configuration. Both the web app and the worker call
 * `getConfig()` at startup; invalid or unsafe combinations fail fast.
 *
 * Safety rules enforced here (see CLAUDE.md "Sending rules"):
 *  - SEND_MODE=live is only accepted when APP_ENV=production.
 *  - SEND_MODE=simulator|allowlist require SEND_AUTHORIZATION_REF (who approved real test sends).
 *  - The local dev sign-in can never be enabled in staging/production.
 */
import { z } from "zod";

export const APP_ENVS = ["local", "test", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const SEND_MODES = ["disabled", "mock", "simulator", "allowlist", "live"] as const;
export type SendMode = (typeof SEND_MODES)[number];

/**
 * Notion access mode (mirrors the sending guard):
 *  - disabled: no Notion calls at all (default);
 *  - mock:     only a local mock server on a loopback address (synthetic data; never production);
 *  - live:     the real Notion API (https://api.notion.com) — requires NOTION_AUTHORIZATION_REF,
 *              i.e. a recorded approval to connect a specific (test) Notion database.
 */
export const NOTION_MODES = ["disabled", "mock", "live"] as const;
export type NotionMode = (typeof NOTION_MODES)[number];
export const NOTION_LIVE_BASE_URL = "https://api.notion.com";
export const NOTION_MOCK_DEFAULT_BASE_URL = "http://127.0.0.1:4010";

function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** "address@domain" or "Display Name <address@domain>" (no line breaks: header injection). */
export const SES_FROM_RE = /^(?:[^<>\r\n]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/;

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    DATABASE_URL: z.string().url().refine((u) => u.startsWith("postgres"), "must be a postgres:// URL"),
    APP_BASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    /** Company Google Workspace domain(s) allowed to sign in, e.g. "company.com". */
    ALLOWED_EMAIL_DOMAINS: csv.refine((a) => a.length > 0, "at least one domain is required"),
    DEV_LOGIN_ENABLED: bool,
    SEND_MODE: z.enum(SEND_MODES).default("disabled"),
    /** Recipients permitted for real test sends outside production (comma separated). */
    TEST_RECIPIENT_ALLOWLIST: csv,
    /** Reference to the explicit approval for real test sends (ticket, date + approver). */
    SEND_AUTHORIZATION_REF: z.string().optional(),
    /** M4: Amazon SES v2 (used only when the guard selects a real transport). */
    SES_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/,"must be an AWS region such as ap-southeast-1").default("ap-southeast-1"),
    /** Verified SES identity used as From for test sends, e.g. "Company <news@mail.company.com>". */
    SES_FROM_ADDRESS: z.string().optional(),
    SES_CONFIGURATION_SET: z.string().optional(),
    /** Provider call timeout. A timeout is recorded as an UNKNOWN outcome and never retried automatically. */
    SES_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    /** Test-send rate limits (per staff member per hour, and for the whole app per day). */
    TEST_SEND_MAX_PER_HOUR: z.coerce.number().int().min(1).max(100).default(10),
    TEST_SEND_MAX_PER_DAY: z.coerce.number().int().min(1).max(1000).default(50),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
    BUILD_ID: z.string().default("dev"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
    HEALTH_MAX_HEARTBEAT_AGE_S: z.coerce.number().int().min(5).default(60),
    /** 32 random bytes, base64url. Encrypts secrets stored in the DB (Notion token). */
    APP_ENCRYPTION_KEY: z.string().optional(),
    APP_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/).default("k1"),
    NOTION_MODE: z.enum(NOTION_MODES).default("disabled"),
    NOTION_API_BASE_URL: z.string().url().optional(),
    NOTION_AUTHORIZATION_REF: z.string().optional(),
    NOTION_RATE_LIMIT_RPS: z.coerce.number().positive().max(3).default(2.5),
  })
  .superRefine((c, ctx) => {
    const nonProd = c.APP_ENV !== "production";
    if (nonProd && c.SEND_MODE === "live") {
      ctx.addIssue({
        code: "custom",
        path: ["SEND_MODE"],
        message: `SEND_MODE=live is forbidden when APP_ENV=${c.APP_ENV}; customer campaigns may only be sent from production`,
      });
    }
    if (c.APP_ENV === "production" && c.SEND_MODE === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["SEND_MODE"],
        message: "SEND_MODE=mock is not allowed in production (it would report fake sends)",
      });
    }
    if ((c.SEND_MODE === "simulator" || c.SEND_MODE === "allowlist") && !c.SEND_AUTHORIZATION_REF) {
      ctx.addIssue({
        code: "custom",
        path: ["SEND_AUTHORIZATION_REF"],
        message: `SEND_MODE=${c.SEND_MODE} requires SEND_AUTHORIZATION_REF (record of explicit approval for real test sends)`,
      });
    }
    if (c.SEND_MODE === "allowlist" && c.TEST_RECIPIENT_ALLOWLIST.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["TEST_RECIPIENT_ALLOWLIST"],
        message: "SEND_MODE=allowlist requires a non-empty TEST_RECIPIENT_ALLOWLIST",
      });
    }
    if ((c.SEND_MODE === "simulator" || c.SEND_MODE === "allowlist" || c.SEND_MODE === "live") && !c.SES_FROM_ADDRESS) {
      ctx.addIssue({
        code: "custom",
        path: ["SES_FROM_ADDRESS"],
        message: `SEND_MODE=${c.SEND_MODE} requires SES_FROM_ADDRESS (a verified SES identity)`,
      });
    }
    if (c.SES_FROM_ADDRESS && !SES_FROM_RE.test(c.SES_FROM_ADDRESS.trim())) {
      ctx.addIssue({ code: "custom", path: ["SES_FROM_ADDRESS"], message: "must be an address or \"Name <address>\"" });
    }
    if (c.DEV_LOGIN_ENABLED && (c.APP_ENV === "staging" || c.APP_ENV === "production")) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_LOGIN_ENABLED"],
        message: "The local dev sign-in can only be enabled when APP_ENV is local or test",
      });
    }
    // ---- Notion access rules
    const keyOk = Boolean(c.APP_ENCRYPTION_KEY && Buffer.from(c.APP_ENCRYPTION_KEY, "base64url").length === 32);
    if (c.APP_ENCRYPTION_KEY && !keyOk) {
      ctx.addIssue({ code: "custom", path: ["APP_ENCRYPTION_KEY"], message: "must be 32 random bytes encoded as base64url" });
    }
    if ((c.NOTION_MODE !== "disabled" || !nonProd || c.APP_ENV === "staging") && !c.APP_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ENCRYPTION_KEY"],
        message: `APP_ENCRYPTION_KEY is required (NOTION_MODE=${c.NOTION_MODE}, APP_ENV=${c.APP_ENV})`,
      });
    }
    if (c.NOTION_MODE === "mock") {
      if (c.APP_ENV === "production") {
        ctx.addIssue({ code: "custom", path: ["NOTION_MODE"], message: "NOTION_MODE=mock is not allowed in production" });
      }
      if (c.NOTION_API_BASE_URL && !isLoopbackUrl(c.NOTION_API_BASE_URL)) {
        ctx.addIssue({
          code: "custom",
          path: ["NOTION_API_BASE_URL"],
          message: "NOTION_MODE=mock only talks to a loopback mock server (127.0.0.1 / localhost)",
        });
      }
    }
    if (c.NOTION_MODE === "live") {
      if (!c.NOTION_AUTHORIZATION_REF) {
        ctx.addIssue({
          code: "custom",
          path: ["NOTION_AUTHORIZATION_REF"],
          message: "NOTION_MODE=live requires NOTION_AUTHORIZATION_REF (record of approval to connect this Notion database)",
        });
      }
      if (c.NOTION_API_BASE_URL && c.NOTION_API_BASE_URL.replace(/\/$/, "") !== NOTION_LIVE_BASE_URL) {
        ctx.addIssue({ code: "custom", path: ["NOTION_API_BASE_URL"], message: `NOTION_MODE=live must use ${NOTION_LIVE_BASE_URL}` });
      }
    }
    if (c.NOTION_MODE === "disabled" && c.NOTION_API_BASE_URL && !isLoopbackUrl(c.NOTION_API_BASE_URL) && c.NOTION_API_BASE_URL !== NOTION_LIVE_BASE_URL) {
      ctx.addIssue({ code: "custom", path: ["NOTION_API_BASE_URL"], message: "unexpected Notion base URL" });
    }

    const hasGoogle = Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET);
    if (!nonProd || c.APP_ENV === "staging") {
      if (!hasGoogle) {
        ctx.addIssue({
          code: "custom",
          path: ["GOOGLE_CLIENT_ID"],
          message: `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when APP_ENV=${c.APP_ENV}`,
        });
      }
      if (!c.APP_BASE_URL.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["APP_BASE_URL"], message: "must use https outside local/test" });
      }
    }
  });

export type AppConfig = z.output<typeof schema> & { googleEnabled: boolean; notionBaseUrl: string | null };

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** Parse a raw env object. Exported for tests; app code uses getConfig(). */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  // `KEY=` (blank) in an env file means "not set" — e.g. NOTION_API_BASE_URL= in .env.example.
  const cleaned = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" ? undefined : v]));
  const r = schema.safeParse(cleaned);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const d = r.data;
  const notionBaseUrl =
    d.NOTION_MODE === "disabled"
      ? null
      : (d.NOTION_API_BASE_URL ?? (d.NOTION_MODE === "live" ? NOTION_LIVE_BASE_URL : NOTION_MOCK_DEFAULT_BASE_URL)).replace(/\/$/, "");
  return { ...d, googleEnabled: Boolean(d.GOOGLE_CLIENT_ID && d.GOOGLE_CLIENT_SECRET), notionBaseUrl };
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** For tests only. */
export function resetConfigCache() {
  cached = undefined;
}
