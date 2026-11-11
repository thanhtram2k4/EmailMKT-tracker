/**
 * M1 acceptance: "Allowed staff sign in; outsiders are rejected."
 * Exercises the real Better Auth instance (HTTP handler, DB adapter, hooks) through the
 * local-only magic-link sign-in. Google OAuth itself is NOT exercised here (no OAuth client
 * available) — the same databaseHooks gate applies to both providers.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testEnv } from "./helpers";

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
type AuthMod = typeof import("../../src/lib/auth/auth");
let authMod: AuthMod;
let dbMod: typeof import("../../src/lib/db/client");
let schema: typeof import("../../src/lib/db/schema");
let staff: typeof import("../../src/lib/staff");
const BASE = "http://localhost:3999";

beforeAll(async () => {
  tdb = await createTestDatabase("it_auth");
  Object.assign(process.env, testEnv(tdb.url));
  (await import("../../src/lib/config")).resetConfigCache();
  authMod = await import("../../src/lib/auth/auth");
  dbMod = await import("../../src/lib/db/client");
  schema = await import("../../src/lib/db/schema");
  staff = await import("../../src/lib/staff");
  const db = dbMod.getDb(tdb.url);
  await staff.addOrUpdateStaff(db, { email: "admin@example.com", role: "admin", actor: "test" });
  await staff.addOrUpdateStaff(db, { email: "member@example.com", role: "member", actor: "test" });
  await staff.addOrUpdateStaff(db, { email: "revoked@example.com", role: "member", actor: "test" });
  await staff.disableStaff(db, { email: "revoked@example.com", actor: "test" });
});
afterAll(async () => {
  await dbMod.closeDb();
  await tdb.drop();
});

/** Request a dev magic link and follow it, returning the verify response. */
async function signIn(email: string, requestId?: string) {
  const auth = authMod.getAuth();
  await auth.api.signInMagicLink({
    body: { email, callbackURL: "/", errorCallbackURL: "/access-denied" },
    headers: new Headers({ origin: BASE }),
  });
  const url = authMod.takeDevMagicLink(email);
  expect(url, "magic link captured").toBeTruthy();
  const headers: Record<string, string> = { origin: BASE };
  if (requestId) headers["x-request-id"] = requestId; // normally set by src/proxy.ts
  const res = await auth.handler(new Request(url!, { method: "GET", headers }));
  return res;
}

async function sessionCountFor(email: string) {
  const db = dbMod.getDb(tdb.url);
  const u = (await db.select().from(schema.user).where(eq(schema.user.email, email)))[0];
  if (!u) return { user: false, sessions: 0 };
  const s = await db.select().from(schema.session).where(eq(schema.session.userId, u.id));
  return { user: true, sessions: s.length };
}

async function deniedAudit(email: string) {
  return dbMod
    .getDb(tdb.url)
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "auth.sign_in_denied"), eq(schema.auditLog.entityId, email)));
}

describe("staff sign-in gate", () => {
  it("lets an allowlisted admin sign in and creates a session cookie", async () => {
    const res = await signIn("admin@example.com");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, BASE).pathname).toBe("/");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/session_token=/);
    expect(await sessionCountFor("admin@example.com")).toEqual({ user: true, sessions: 1 });

    // The cookie resolves to a session for that user.
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    const s = await authMod.getAuth().api.getSession({ headers: new Headers({ cookie }) });
    expect(s?.user.email).toBe("admin@example.com");
  });

  it("lets an allowlisted member sign in (address normalized)", async () => {
    const res = await signIn("Member@Example.com".toLowerCase());
    expect(new URL(res.headers.get("location")!, BASE).pathname).toBe("/");
  });

  it("rejects a company-domain account that is not on the allowlist", async () => {
    const res = await signIn("stranger@example.com");
    const loc = new URL(res.headers.get("location")!, BASE);
    expect(loc.pathname).toBe("/access-denied");
    expect(loc.searchParams.get("error")).toBe("ACCESS_DENIED_NOT_ALLOWLISTED");
    expect(await sessionCountFor("stranger@example.com")).toEqual({ user: false, sessions: 0 });
    expect(await deniedAudit("stranger@example.com")).toHaveLength(1);
  });

  it("rejects an outside-domain account and correlates the audit row with the request id", async () => {
    const res = await signIn("outsider@freemail.example", "it-req-outsider-1");
    const loc = new URL(res.headers.get("location")!, BASE);
    expect(loc.pathname).toBe("/access-denied");
    expect(loc.searchParams.get("error")).toBe("ACCESS_DENIED_WRONG_DOMAIN");
    expect(await sessionCountFor("outsider@freemail.example")).toEqual({ user: false, sessions: 0 });
    const rows = await deniedAudit("outsider@freemail.example");
    expect(rows.map((r) => r.correlationId)).toContain("it-req-outsider-1");
  });

  it("rejects a revoked staff member", async () => {
    const res = await signIn("revoked@example.com");
    const loc = new URL(res.headers.get("location")!, BASE);
    expect(loc.searchParams.get("error")).toBe("ACCESS_DENIED_DISABLED");
    expect((await sessionCountFor("revoked@example.com")).sessions).toBe(0);
  });

  it("revoking an existing user ends their sessions and blocks the next sign-in", async () => {
    const db = dbMod.getDb(tdb.url);
    expect((await sessionCountFor("member@example.com")).sessions).toBeGreaterThan(0);
    await staff.disableStaff(db, { email: "member@example.com", actor: "test" });
    expect((await sessionCountFor("member@example.com")).sessions).toBe(0);

    // The user row exists now, so this path is denied by the session.create hook.
    const res = await signIn("member@example.com");
    // Must be a redirect to the access-denied page (regression: previously a raw JSON 403).
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, BASE);
    expect(loc.pathname).toBe("/access-denied");
    expect(loc.searchParams.get("error")).toBe("failed_to_create_session");
    expect((await sessionCountFor("member@example.com")).sessions).toBe(0);
    const denied = await deniedAudit("member@example.com");
    expect(denied.map((d) => d.after)).toContainEqual({ reason: "disabled", stage: "session.create" });
  });

  it("records audit entries for successful sign-ins and staff changes", async () => {
    const rows = await dbMod.getDb(tdb.url).select().from(schema.auditLog);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.sign_in");
    expect(actions).toContain("staff.added");
    expect(actions).toContain("staff.disabled");
  });
});
