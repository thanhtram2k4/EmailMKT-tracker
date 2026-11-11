/**
 * Run a local PostgreSQL 17 for development (no Docker needed). Keep this terminal open.
 * Data lives in .local/postgres (git-ignored). Stop with Ctrl+C.
 *
 *   npm run db:start            # port 54321, database emt_dev
 */
import { localDatabaseUrl, startLocalPostgres } from "./lib/embedded-pg.ts";

const port = Number(process.env.LOCAL_PG_PORT ?? 54321);
const dbName = process.env.LOCAL_PG_DB ?? "emt_dev";

const h = await startLocalPostgres({ dir: ".local/postgres", port, quiet: true });
await h.ensureDatabase(dbName);
console.log(`Local Postgres ready: ${localDatabaseUrl(port, dbName)}`);
console.log("Press Ctrl+C to stop.");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await h.stop();
  console.log("Local Postgres stopped.");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
