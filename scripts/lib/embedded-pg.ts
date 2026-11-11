/**
 * Local-only Postgres for development and tests (no Docker required).
 * Uses the project-local `embedded-postgres` package (real PostgreSQL 17 binaries).
 * Never used in staging or production; those use a managed Postgres via DATABASE_URL.
 */
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/*
 * embedded-postgres registers `async-exit-hook`, which listens to Node's `beforeExit` (and IPC
 * "message") events and then calls process.exit(0). That OVERRIDES a failing process.exitCode —
 * e.g. Vitest reporting failed tests would exit 0 (found during M2, see the M2 test report).
 * Its "exit" hook also calls an undefined callback ("done is not a function") once the beforeExit
 * path no longer pre-empts it, which crashes the process with code 1 after successful runs.
 * Every caller here stops its cluster explicitly, so we remove those three hooks; the
 * SIGINT/SIGTERM/SIGHUP/SIGBREAK clean-up hooks (non-zero exit codes) are kept.
 */
{
  const require = createRequire(import.meta.url);
  const hook = require("async-exit-hook") as { unhookEvent?: (e: string) => void; hookedEvents?: () => string[] };
  for (const ev of ["beforeExit", "message", "exit"]) {
    if (hook.hookedEvents?.().includes(ev)) hook.unhookEvent?.(ev);
  }
}

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
