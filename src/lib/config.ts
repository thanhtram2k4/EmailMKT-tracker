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
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
    BUILD_ID: z.string().default("dev"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
    HEALTH_MAX_HEARTBEAT_AGE_S: z.coerce.number().int().min(5).default(60),
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
    if (c.DEV_LOGIN_ENABLED && (c.APP_ENV === "staging" || c.APP_ENV === "production")) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_LOGIN_ENABLED"],
        message: "The local dev sign-in can only be enabled when APP_ENV is local or test",
      });
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

export type AppConfig = z.output<typeof schema> & { googleEnabled: boolean };

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** Parse a raw env object. Exported for tests; app code uses getConfig(). */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return { ...r.data, googleEnabled: Boolean(r.data.GOOGLE_CLIENT_ID && r.data.GOOGLE_CLIENT_SECRET) };
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
