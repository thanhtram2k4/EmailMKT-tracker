/**
 * Apply application migrations (./drizzle) and install/upgrade the Graphile Worker schema.
 * Usage: npm run db:migrate            (uses DATABASE_URL from env / .env.local)
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadLocalEnv } from "./lib/env-file.ts";

export async function migrateDatabase(databaseUrl: string, opts: { quiet?: boolean } = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  pool.on("error", (err) => console.error("migration pool error:", err.message));
  try {
    const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
    await migrate(drizzle(pool), { migrationsFolder });
    await runMigrations({ pgPool: pool, logger: undefined });
    if (!opts.quiet) console.log("migrations applied (app + graphile_worker)");
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadLocalEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrateDatabase(url).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
