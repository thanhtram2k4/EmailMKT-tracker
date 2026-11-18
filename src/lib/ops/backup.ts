/**
 * M8 logical backup / restore of the application database (provider-independent).
 *
 *  - Export: every table of the `public` schema, in foreign-key order, as JSON lines (`row_to_json`),
 *    plus a manifest with the number of applied migrations, row counts and a checksum per table.
 *  - Restore: only into a database migrated to the SAME number of migrations and EMPTY; all tables in
 *    one transaction (`json_populate_recordset`, so every type round-trips exactly); serial sequences
 *    are moved past the restored ids. DB triggers stay active (append-only rules keep working).
 *  - Verify: recompute the checksums in the target and compare with the manifest.
 *
 * Not included: the Graphile Worker queue (jobs are recreated by the every-minute sweepers, including
 * scheduled-campaign starts at their due time) and the migrations table (the target is migrated first).
 * A backup contains personal data and the ENCRYPTED Notion token: store it like the database itself.
 * In production the hosting provider's managed backups remain the primary mechanism (docs/RUNBOOK.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

export type Manifest = {
  format: "emt-logical-backup/1";
  createdAt: string;
  migrations: number;
  tables: Array<{ name: string; rows: number; checksum: string }>;
};

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;

async function tablesInFkOrder(c: pg.ClientBase): Promise<string[]> {
  const tables = (await c.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.table_name as string);
  const deps = (
    await c.query(`
      select tc.relname as child, tp.relname as parent
      from pg_constraint k join pg_class tc on tc.oid = k.conrelid join pg_class tp on tp.oid = k.confrelid
      join pg_namespace n on n.oid = tc.relnamespace
      where k.contype = 'f' and n.nspname = 'public' and tc.relname <> tp.relname`)
  ).rows as Array<{ child: string; parent: string }>;
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (done.has(t)) return;
    if (visiting.has(t)) throw new Error(`foreign-key cycle at ${t}`);
    visiting.add(t);
    for (const d of deps.filter((x) => x.child === t)) visit(d.parent);
    visiting.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t);
  return order;
}

async function checksum(c: pg.ClientBase, table: string): Promise<{ rows: number; checksum: string }> {
  const r = await c.query(`select count(*)::int as rows, md5(coalesce(string_agg(j, E'\\n' order by j), '')) as checksum
                           from (select row_to_json(t)::text as j from ${ident(table)} t) x`);
  return r.rows[0] as { rows: number; checksum: string };
}

async function migrationCount(c: pg.ClientBase): Promise<number> {
  return Number((await c.query(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0].n);
}

export async function exportDatabase(c: pg.ClientBase, dir: string): Promise<Manifest> {
  mkdirSync(dir, { recursive: true });
  // One consistent snapshot of every table.
  await c.query("begin isolation level repeatable read read only");
  try {
    const tables = await tablesInFkOrder(c);
    const manifest: Manifest = { format: "emt-logical-backup/1", createdAt: new Date().toISOString(), migrations: await migrationCount(c), tables: [] };
    for (const t of tables) {
      const rows = (await c.query(`select row_to_json(t)::text as j from ${ident(t)} t`)).rows.map((r) => r.j as string);
      writeFileSync(path.join(dir, `${t}.jsonl`), rows.length ? rows.join("\n") + "\n" : "");
      manifest.tables.push({ name: t, ...(await checksum(c, t)) });
    }
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await c.query("commit");
    return manifest;
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}

export class RestoreRefused extends Error {}

export async function restoreDatabase(c: pg.ClientBase, dir: string): Promise<{ tables: number; rows: number }> {
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== "emt-logical-backup/1") throw new RestoreRefused("unknown backup format");
  const migrations = await migrationCount(c);
  if (migrations !== manifest.migrations) throw new RestoreRefused(`the target has ${migrations} migrations applied; the backup was taken at ${manifest.migrations}`);
  const target = await tablesInFkOrder(c);
  for (const t of target) {
    const n = Number((await c.query(`select count(*)::int as n from ${ident(t)}`)).rows[0].n);
    if (n > 0) throw new RestoreRefused(`the target is not empty (${t} has ${n} rows); restore only into a freshly migrated database`);
  }
  let total = 0;
  await c.query("begin");
  try {
    for (const { name } of manifest.tables) {
      if (!target.includes(name)) throw new RestoreRefused(`table ${name} does not exist in the target`);
      const lines = readFileSync(path.join(dir, `${name}.jsonl`), "utf8").split("\n").filter(Boolean);
      for (let k = 0; k < lines.length; k += 500) {
        const chunk = `[${lines.slice(k, k + 500).join(",")}]`;
        await c.query(`insert into ${ident(name)} select * from json_populate_recordset(null::${ident(name)}, $1::json)`, [chunk]);
      }
      total += lines.length;
      // Move serial sequences past the restored ids.
      const seqCols = (
        await c.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and column_default like 'nextval(%'`, [name])
      ).rows.map((r) => r.column_name as string);
      for (const col of seqCols) {
        await c.query(`select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${ident(col)}) from ${ident(name)}), 0) + 1, false)`, [`public.${ident(name)}`, col]);
      }
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
  return { tables: manifest.tables.length, rows: total };
}

export async function verifyRestore(c: pg.ClientBase, dir: string): Promise<Array<{ table: string; expected: string; actual: string; rows: number }>> {
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  const mismatches: Array<{ table: string; expected: string; actual: string; rows: number }> = [];
  for (const t of manifest.tables) {
    const now = await checksum(c, t.name);
    if (now.checksum !== t.checksum || now.rows !== t.rows) mismatches.push({ table: t.name, expected: `${t.rows}/${t.checksum}`, actual: `${now.rows}/${now.checksum}`, rows: now.rows });
  }
  return mismatches;
}

/**
 * Full drill on the same server: export `sourceUrl` → create a fresh database → migrate → restore →
 * verify → drop it. Only for databases on a loopback host (local stack); refuses anything else.
 */
export async function restoreDrill(
  sourceUrl: string,
  dir: string,
  migrate: (url: string) => Promise<void>,
  connect: (url: string) => Promise<{ client: pg.ClientBase; end: () => Promise<void> }>,
): Promise<{ tables: number; rows: number; mismatches: number; ms: number }> {
  const u = new URL(sourceUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) throw new RestoreRefused("the drill only runs against a local (loopback) database server");
  const t0 = Date.now();
  const src = await connect(sourceUrl);
  try {
    await exportDatabase(src.client, dir);
  } finally {
    await src.end();
  }
  const name = `emt_restore_drill_${Date.now().toString(36)}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const admin = await connect(adminUrl.toString());
  await admin.client.query(`create database "${name}"`);
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${name}`;
  try {
    await migrate(targetUrl.toString());
    const tgt = await connect(targetUrl.toString());
    try {
      const r = await restoreDatabase(tgt.client, dir);
      const m = await verifyRestore(tgt.client, dir);
      return { ...r, mismatches: m.length, ms: Date.now() - t0 };
    } finally {
      await tgt.end();
    }
  } finally {
    await admin.client.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}
