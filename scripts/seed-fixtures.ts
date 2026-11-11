/**
 * FIXTURE DATA for local stacks, E2E and smoke runs. All addresses are fake (example.com /
 * example.net, reserved by RFC 2606) — never real people.
 */
import { loadLocalEnv } from "./lib/env-file.ts";
loadLocalEnv();
const { getDb, closeDb } = await import("../src/lib/db/client.ts");
const { addOrUpdateStaff, disableStaff } = await import("../src/lib/staff.ts");

export const FIXTURE_STAFF = {
  admin: "admin@example.com",
  member: "member@example.com",
  revoked: "revoked@example.com",
  notAllowlisted: "stranger@example.com",
  outsider: "outsider@example.net",
};

const db = getDb();
await addOrUpdateStaff(db, { email: FIXTURE_STAFF.admin, role: "admin", actor: "fixture-seed" });
await addOrUpdateStaff(db, { email: FIXTURE_STAFF.member, role: "member", actor: "fixture-seed" });
await addOrUpdateStaff(db, { email: "member2@example.com", role: "member", actor: "fixture-seed" }); // revoked mid-session by E2E
await addOrUpdateStaff(db, { email: FIXTURE_STAFF.revoked, role: "member", actor: "fixture-seed" });
await disableStaff(db, { email: FIXTURE_STAFF.revoked, actor: "fixture-seed" });
await closeDb();
console.log("fixture staff seeded");
