import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { activeStaffRole, type StaffRole } from "./access";
import { getAuth } from "./auth";

export type CurrentStaff = { userId: string; email: string; name: string; role: StaffRole };

/**
 * Returns the signed-in staff member, re-checking the allowlist on every request so that
 * revoking access takes effect immediately (not only at the next sign-in).
 */
export async function getCurrentStaff(): Promise<CurrentStaff | null> {
  const s = await getAuth().api.getSession({ headers: await headers() });
  if (!s) return null;
  const role = await activeStaffRole(getDb(), s.user.email);
  if (!role) return null;
  return { userId: s.user.id, email: s.user.email, name: s.user.name, role };
}

export async function requireStaff(): Promise<CurrentStaff> {
  const s = await getCurrentStaff();
  if (!s) redirect("/sign-in");
  return s;
}

export async function requireRole(role: StaffRole): Promise<CurrentStaff> {
  const s = await requireStaff();
  if (role === "admin" && s.role !== "admin") redirect("/forbidden");
  return s;
}
