/**
 * Staff access gate. Signing in to the app (identity) is separate from being
 * allowed to use it (authorization). Every sign-in path — Google OAuth or the
 * local-only dev sign-in — goes through `evaluateAccess`, and every request
 * re-checks the allowlist so revocation takes effect immediately.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { staffAllowlist } from "../db/schema";

export type StaffRole = "admin" | "member";

export type AccessDecision =
  | { allowed: true; role: StaffRole; email: string }
  | { allowed: false; reason: AccessDenialReason; email: string };

export type AccessDenialReason = "email_unverified" | "wrong_domain" | "not_allowlisted" | "disabled";

export const DENIAL_MESSAGES: Record<AccessDenialReason, string> = {
  email_unverified: "Your email address is not verified by the identity provider.",
  wrong_domain: "Only company accounts can sign in to this app.",
  not_allowlisted: "Your account has not been granted access. Ask an administrator to add you.",
  disabled: "Your access to this app has been revoked. Ask an administrator if this is unexpected.",
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** Pure part of the decision (no DB) — unit tested exhaustively. */
export function checkIdentity(
  identity: { email: string; emailVerified: boolean },
  allowedDomains: string[],
): { ok: true; email: string } | { ok: false; reason: AccessDenialReason; email: string } {
  const email = normalizeEmail(identity.email);
  if (!identity.emailVerified) return { ok: false, reason: "email_unverified", email };
  if (!allowedDomains.includes(emailDomain(email))) return { ok: false, reason: "wrong_domain", email };
  return { ok: true, email };
}

export async function evaluateAccess(
  db: Db,
  identity: { email: string; emailVerified: boolean },
  allowedDomains: string[],
): Promise<AccessDecision> {
  const id = checkIdentity(identity, allowedDomains);
  if (!id.ok) return { allowed: false, reason: id.reason, email: id.email };
  const rows = await db.select().from(staffAllowlist).where(eq(staffAllowlist.email, id.email)).limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: "not_allowlisted", email: id.email };
  if (row.disabledAt) return { allowed: false, reason: "disabled", email: id.email };
  return { allowed: true, role: row.role, email: id.email };
}

export async function activeStaffRole(db: Db, email: string): Promise<StaffRole | null> {
  const rows = await db
    .select({ role: staffAllowlist.role })
    .from(staffAllowlist)
    .where(and(eq(staffAllowlist.email, normalizeEmail(email)), isNull(staffAllowlist.disabledAt)))
    .limit(1);
  return rows[0]?.role ?? null;
}
