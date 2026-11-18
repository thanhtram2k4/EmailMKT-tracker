/**
 * Logical backup CLI (docs/RUNBOOK.md "Backups and restore").
 *
 *   npm run backup -- export --out <dir>                       (DATABASE_URL from env / .env.local)
 *   npm run backup -- restore --from <dir> --database-url <url> (target: freshly migrated, empty)
 *   npm run backup -- verify --from <dir> --database-url <url>
 *   npm run backup -- drill --out <dir>        (local server only: export → fresh DB → restore → verify → drop)
 *
 * Backups contain personal data and the encrypted Notion token: keep them out of Git (use .local/ or
 * secure storage) and delete them when no longer needed. Exit code 1 on any failure or mismatch.
 */
import pg from "pg";
import { loadLocalEnv } from "./lib/env-file.ts";
import { exportDatabase, restoreDatabase, restoreDrill, verifyRestore } from "../src/lib/ops/backup.ts";
import { migrateDatabase } from "./migrate.ts";

loadLocalEnv();
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n: string) => {
  const i = rest.indexOf(n);
  return i === -1 ? undefined : rest[i + 1];
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

try {
  if (cmd === "export") {
    const out = opt("--out");
    if (!out || !process.env.DATABASE_URL) throw new Error("usage: export --out <dir> (with DATABASE_URL set)");
    const m = await withClient(process.env.DATABASE_URL, (c) => exportDatabase(c, out));
    console.log(`exported ${m.tables.length} tables, ${m.tables.reduce((a, t) => a + t.rows, 0)} rows, migrations ${m.migrations} → ${out}`);
  } else if (cmd === "drill") {
    const out = opt("--out");
    if (!out || !process.env.DATABASE_URL) throw new Error("usage: drill --out <dir> (with DATABASE_URL set)");
    const r = await restoreDrill(process.env.DATABASE_URL, out, (u) => migrateDatabase(u, { quiet: true }), async (u) => {
      const c = new pg.Client({ connectionString: u });
      await c.connect();
      return { client: c, end: () => c.end() };
    });
    console.log(JSON.stringify(r));
    if (r.mismatches) process.exit(1);
  } else if (cmd === "restore" || cmd === "verify") {
    const from = opt("--from");
    const url = opt("--database-url");
    if (!from || !url) throw new Error(`usage: ${cmd} --from <dir> --database-url <url>`);
    if (cmd === "restore") {
      const r = await withClient(url, (c) => restoreDatabase(c, from));
      console.log(`restored ${r.tables} tables, ${r.rows} rows`);
    }
    const mism = await withClient(url, (c) => verifyRestore(c, from));
    if (mism.length) {
      console.error("verification FAILED:", JSON.stringify(mism, null, 2));
      process.exit(1);
    }
    console.log("verification ok: every table matches the manifest (row count and checksum)");
  } else {
    throw new Error("usage: backup export|restore|verify …");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
