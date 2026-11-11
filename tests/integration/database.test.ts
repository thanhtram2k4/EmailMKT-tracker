import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "../../src/lib/audit";
import { closeDb, getDb } from "../../src/lib/db/client";
import { migrateDatabase } from "../../scripts/migrate";
import { createTestDatabase } from "./helpers";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase("it_db");
});
afterAll(async () => {
  await closeDb();
  await db.drop();
});

describe("database migrations", () => {
  it("creates application, auth and worker schemas", async () => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    const r = await c.query(
      "select table_schema, table_name from information_schema.tables where table_schema in ('public','graphile_worker') order by 1,2",
    );
    await c.end();
    const names = r.rows.map((x) => `${x.table_schema}.${x.table_name}`);
    for (const t of ["user", "session", "account", "verification", "staff_allowlist", "audit_log", "app_settings", "worker_heartbeats", "system_probes"]) {
      expect(names).toContain(`public.${t}`);
    }
    expect(names.some((n) => n.startsWith("graphile_worker."))).toBe(true);
  });

  it("is idempotent when re-run", async () => {
    await expect(migrateDatabase(db.url, { quiet: true })).resolves.toBeUndefined();
  });

  it("enforces an append-only audit log at the database level", async () => {
    const d = getDb(db.url);
    await writeAudit(d, { actor: "system", action: "test.event", after: { a: 1 } });
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await expect(c.query("update audit_log set action = 'tampered'")).rejects.toThrow(/append-only/);
      await expect(c.query("delete from audit_log")).rejects.toThrow(/append-only/);
      await expect(c.query("truncate audit_log")).rejects.toThrow(/append-only/);
      const r = await c.query("select action from audit_log");
      expect(r.rows.map((x) => x.action)).toEqual(["test.event"]);
    } finally {
      await c.end();
    }
  });
});
