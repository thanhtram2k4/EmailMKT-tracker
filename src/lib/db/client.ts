import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

type Holder = { pool?: pg.Pool; db?: Db; url?: string };
// Survive Next.js dev hot reloads without leaking pools.
const holder: Holder = ((globalThis as Record<string, unknown>).__emtDb ??= {}) as Holder;

export function getPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!holder.pool || holder.url !== databaseUrl) {
    holder.pool = new pg.Pool({ connectionString: databaseUrl, max: 10, application_name: process.env.SERVICE_NAME ?? "web" });
    // An idle client error (e.g. DB restart) must not crash the process; queries will retry on new clients.
    holder.pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "pg pool error", err: err.message })));
    holder.url = databaseUrl;
    holder.db = drizzle(holder.pool, { schema });
  }
  return holder.pool;
}

export function getDb(databaseUrl?: string): Db {
  getPool(databaseUrl);
  return holder.db!;
}

export async function closeDb() {
  const p = holder.pool;
  holder.pool = undefined;
  holder.db = undefined;
  holder.url = undefined;
  await p?.end();
}

export { schema };
