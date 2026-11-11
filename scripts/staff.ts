/**
 * Manage the staff allowlist from the command line (admin UI arrives later).
 *   npm run staff:add -- alice@company.example admin
 *   npm run staff:add -- bob@company.example member
 *   npm run staff:disable -- bob@company.example
 *   npm run staff:list
 * Every change is written to audit_log with actor "cli:<os user>".
 */
import os from "node:os";
import { loadLocalEnv } from "./lib/env-file.ts";

loadLocalEnv();
const { getDb, closeDb } = await import("../src/lib/db/client.ts");
const { addOrUpdateStaff, disableStaff, listStaff } = await import("../src/lib/staff.ts");

const [cmd, email, role] = process.argv.slice(2);
const actor = `cli:${os.userInfo().username}`;
const db = getDb();
try {
  if (cmd === "add") {
    if (!email || (role !== "admin" && role !== "member")) throw new Error("usage: staff:add -- <email> <admin|member>");
    const r = await addOrUpdateStaff(db, { email, role, actor });
    console.log(`${r.created ? "added" : "updated"} ${r.email} as ${role}`);
  } else if (cmd === "disable") {
    if (!email) throw new Error("usage: staff:disable -- <email>");
    const ok = await disableStaff(db, { email, actor });
    console.log(ok ? `disabled ${email}` : `no active entry for ${email}`);
  } else if (cmd === "list") {
    for (const s of await listStaff(db)) {
      console.log(`${s.email}\t${s.role}\t${s.disabledAt ? "DISABLED " + s.disabledAt.toISOString() : "active"}`);
    }
  } else {
    throw new Error("unknown command (add | disable | list)");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
