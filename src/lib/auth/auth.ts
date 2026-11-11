/**
 * Better Auth configuration.
 *
 * Identity providers:
 *  - Google (company Workspace). Scopes are only `openid email profile`; the MVP does NOT
 *    request any Gmail scope. `hd` restricts the account chooser and is enforced against the
 *    id-token claim by Better Auth; we additionally enforce domain + allowlist ourselves.
 *  - Local dev sign-in (APP_ENV=local|test with DEV_LOGIN_ENABLED=true only), implemented
 *    with Better Auth's magic-link plugin whose link is returned to the caller instead of
 *    being emailed. It goes through the same access gate as Google.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { eq } from "drizzle-orm";
import { getConfig, type AppConfig } from "../config";
import { writeAudit } from "../audit";
import { getDb, type Db } from "../db/client";
import * as schema from "../db/schema";
import { getLogger } from "../logger";
import { evaluateAccess, type AccessDecision } from "./access";

/** Captures dev magic links per email so the dev sign-in route can return them. */
const devLinks: Map<string, string> = ((globalThis as Record<string, unknown>).__emtDevLinks ??= new Map()) as Map<
  string,
  string
>;
export function takeDevMagicLink(email: string): string | undefined {
  const url = devLinks.get(email.toLowerCase());
  devLinks.delete(email.toLowerCase());
  return url;
}

/** Correlation id set by src/proxy.ts (x-request-id), when the hook runs inside an HTTP request. */
function requestIdOf(ctx: unknown): string | undefined {
  const c = ctx as { headers?: Headers; request?: Request } | null;
  return c?.headers?.get?.("x-request-id") ?? c?.request?.headers.get("x-request-id") ?? undefined;
}

async function enforceAccess(
  db: Db,
  cfg: AppConfig,
  identity: { email: string; emailVerified: boolean },
  stage: string,
  requestId?: string,
) {
  const decision: AccessDecision = await evaluateAccess(db, identity, cfg.ALLOWED_EMAIL_DOMAINS);
  if (!decision.allowed) {
    await writeAudit(db, {
      actor: "anonymous",
      action: "auth.sign_in_denied",
      entityType: "staff",
      entityId: decision.email,
      after: { reason: decision.reason, stage },
      correlationId: requestId,
    });
    getLogger().warn({ request_id: requestId, reason: decision.reason, stage }, "sign-in denied");
    throw new APIError("FORBIDDEN", { message: decision.reason, code: `ACCESS_DENIED_${decision.reason.toUpperCase()}` });
  }
  return decision;
}

function buildAuth(cfg: AppConfig) {
  const db = getDb(cfg.DATABASE_URL);
  const devLogin = cfg.DEV_LOGIN_ENABLED && (cfg.APP_ENV === "local" || cfg.APP_ENV === "test");

  return betterAuth({
    appName: "Email MKT Tracker",
    baseURL: cfg.APP_BASE_URL,
    secret: cfg.BETTER_AUTH_SECRET,
    trustedOrigins: [cfg.APP_BASE_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 3, updateAge: 60 * 60 * 12 },
    socialProviders: cfg.googleEnabled
      ? {
          google: {
            clientId: cfg.GOOGLE_CLIENT_ID!,
            clientSecret: cfg.GOOGLE_CLIENT_SECRET!,
            scope: ["openid", "email", "profile"],
            prompt: "select_account",
            // Only a single-domain hint can be sent to Google; multi-domain falls back to our own check.
            hd: cfg.ALLOWED_EMAIL_DOMAINS.length === 1 ? cfg.ALLOWED_EMAIL_DOMAINS[0] : "*",
          },
        }
      : {},
    databaseHooks: {
      user: {
        create: {
          before: async (u, ctx) => {
            await enforceAccess(db, cfg, { email: u.email, emailVerified: Boolean(u.emailVerified) }, "user.create", requestIdOf(ctx));
            return { data: { ...u, email: u.email.toLowerCase() } };
          },
        },
      },
      session: {
        create: {
          // Returning false (instead of throwing) makes every sign-in path — Google callback and the
          // dev magic link — redirect to the error page rather than returning a raw JSON error.
          // The precise reason is recorded in audit_log by enforceAccess.
          before: async (s, ctx) => {
            const requestId = requestIdOf(ctx);
            const rows = await db.select().from(schema.user).where(eq(schema.user.id, s.userId)).limit(1);
            const u = rows[0];
            if (!u) return false;
            let d: AccessDecision;
            try {
              d = await enforceAccess(db, cfg, { email: u.email, emailVerified: u.emailVerified }, "session.create", requestId);
            } catch (e) {
              if (e instanceof APIError) return false;
              throw e;
            }
            if (!d.allowed) return false;
            await writeAudit(db, {
              actor: `user:${u.id}`,
              action: "auth.sign_in",
              entityType: "staff",
              entityId: d.email,
              after: { role: d.role },
              correlationId: requestId,
            });
            getLogger().info({ request_id: requestId, role: d.role }, "sign-in succeeded");
            return { data: s };
          },
        },
      },
    },
    plugins: [
      ...(devLogin
        ? [
            magicLink({
              expiresIn: 300,
              // Dev/test-only plugin: the default (5 verifications / 60 s) throttles automated E2E runs.
              // Production sign-in paths keep Better Auth's default rate limits.
              rateLimit: { window: 60, max: 100 },
              sendMagicLink: async ({ email, url }) => {
                // Local/test only: never emailed — handed back to the dev sign-in route.
                devLinks.set(email.toLowerCase(), url);
              },
            }),
          ]
        : []),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;
const holder = ((globalThis as Record<string, unknown>).__emtAuth ??= {}) as { auth?: Auth };

export function getAuth(): Auth {
  holder.auth ??= buildAuth(getConfig());
  return holder.auth;
}
