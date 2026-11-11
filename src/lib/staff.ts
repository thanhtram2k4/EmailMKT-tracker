import { asc, eq } from "drizzle-orm";
import { writeAudit } from "./audit";
import { normalizeEmail, type StaffRole } from "./auth/access";
import type { Db } from "./db/client";
import { session, staffAllowlist, user } from "./db/schema";

export async function addOrUpdateStaff(db: Db, i: { email: string; role: StaffRole; actor: string }) {
  const email = normalizeEmail(i.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`invalid email: ${i.email}`);
  return db.transaction(async (tx) => {
    const before = (await tx.select().from(staffAllowlist).where(eq(staffAllowlist.email, email)).limit(1))[0];
    if (before) {
      await tx
        .update(staffAllowlist)
        .set({ role: i.role, disabledAt: null, disabledBy: null })
        .where(eq(staffAllowlist.email, email));
    } else {
      await tx.insert(staffAllowlist).values({ email, role: i.role, addedBy: i.actor });
    }
    await writeAudit(tx as unknown as Db, {
      actor: i.actor,
      action: before ? "staff.updated" : "staff.added",
      entityType: "staff",
      entityId: email,
      before: before ? { role: before.role, disabled: Boolean(before.disabledAt) } : null,
      after: { role: i.role, disabled: false },
    });
    return { email, created: !before };
  });
}

/** Revoke access: keeps the row for audit and ends the person's existing sessions. */
export async function disableStaff(db: Db, i: { email: string; actor: string }) {
  const email = normalizeEmail(i.email);
  return db.transaction(async (tx) => {
    const before = (await tx.select().from(staffAllowlist).where(eq(staffAllowlist.email, email)).limit(1))[0];
    if (!before || before.disabledAt) return false;
    await tx
      .update(staffAllowlist)
      .set({ disabledAt: new Date(), disabledBy: i.actor })
      .where(eq(staffAllowlist.email, email));
    const u = (await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1))[0];
    if (u) await tx.delete(session).where(eq(session.userId, u.id));
    await writeAudit(tx as unknown as Db, {
      actor: i.actor,
      action: "staff.disabled",
      entityType: "staff",
      entityId: email,
      before: { role: before.role, disabled: false },
      after: { role: before.role, disabled: true },
    });
    return true;
  });
}

export async function listStaff(db: Db) {
  return db.select().from(staffAllowlist).orderBy(asc(staffAllowlist.email));
}
