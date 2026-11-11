/**
 * Local-only Postgres for development and tests (no Docker required).
 * Uses the project-local `embedded-postgres` package (real PostgreSQL 17 binaries).
 * Never used in staging or production; those use a managed Postgres via DATABASE_URL.
 */
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

export interface LocalPgOptions {
  /** Directory for the cluster's data files, relative to the repo root. */
  dir: string;
  port: number;
  /** Delete data on stop (used for throwaway test clusters). */
  ephemeral?: boolean;
  quiet?: boolean;
}

export const LOCAL_PG_USER = "postgres";
export const LOCAL_PG_PASSWORD = "postgres-local-only";

export function localDatabaseUrl(port: number, database: string): string {
  return `postgres://${LOCAL_PG_USER}:${LOCAL_PG_PASSWORD}@127.0.0.1:${port}/${database}`;
}

export async function startLocalPostgres(opts: LocalPgOptions) {
  const databaseDir = path.resolve(opts.dir);
  const alreadyInitialised = fs.existsSync(path.join(databaseDir, "PG_VERSION"));
  const pg = new EmbeddedPostgres({
    databaseDir,
    port: opts.port,
    user: LOCAL_PG_USER,
    password: LOCAL_PG_PASSWORD,
    authMethod: "scram-sha-256",
    persistent: !opts.ephemeral,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: opts.quiet ? () => {} : (m) => process.stdout.write(`[postgres] ${m}`),
    onError: (e) => process.stderr.write(`[postgres:err] ${String(e)}\n`),
  });
  if (!alreadyInitialised) {
    fs.mkdirSync(path.dirname(databaseDir), { recursive: true });
    await pg.initialise();
  }
  await pg.start();
  return {
    pg,
    async ensureDatabase(name: string) {
      const client = pg.getPgClient("postgres", "127.0.0.1");
      await client.connect();
      try {
        const r = await client.query("select 1 from pg_database where datname = $1", [name]);
        if (r.rowCount === 0) await client.query(`create database "${name.replace(/"/g, "")}"`);
      } finally {
        await client.end();
      }
    },
    async dropDatabase(name: string) {
      const client = pg.getPgClient("postgres", "127.0.0.1");
      await client.connect();
      try {
        await client.query(`drop database if exists "${name.replace(/"/g, "")}" with (force)`);
      } finally {
        await client.end();
      }
    },
    stop: () => pg.stop(),
  };
}
