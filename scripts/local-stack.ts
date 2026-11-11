/**
 * Start an isolated local stack — throwaway PostgreSQL 17, production build of the web app,
 * and the background worker — run a command against it, then tear everything down.
 * Nothing here talks to Google, AWS, Notion or any email provider.
 *
 *   tsx scripts/local-stack.ts [--port 3100] [--log-dir DIR] [--no-build] -- <command> [args...]
 *
 * The command receives E2E_BASE_URL and DATABASE_URL in its environment.
 * Used by `npm run e2e` and `npm run smoke:local`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localDatabaseUrl, startLocalPostgres } from "./lib/embedded-pg.ts";
import { migrateDatabase } from "./migrate.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? argv : argv.slice(0, sep);
const cmd = sep === -1 ? [] : argv.slice(sep + 1);
const opt = (name: string, def?: string) => {
  const i = own.indexOf(name);
  return i === -1 ? def : own[i + 1];
};
const appPort = Number(opt("--port", "3100"));
const pgPort = Number(opt("--pg-port", "54332"));
const logDir = path.resolve(opt("--log-dir", path.join(".local", "logs", new Date().toISOString().replace(/[:.]/g, "-")))!);
const build = !own.includes("--no-build");
if (!cmd.length) {
  console.error("usage: tsx scripts/local-stack.ts [options] -- <command>");
  process.exit(2);
}
fs.mkdirSync(logDir, { recursive: true });

const baseUrl = `http://localhost:${appPort}`;
const mockPort = Number(opt("--notion-mock-port", "4011"));
const dbName = "emt_stack";
const databaseUrl = localDatabaseUrl(pgPort, dbName);
const appEnv: NodeJS.ProcessEnv = {
  ...process.env,
  APP_ENV: "test",
  DATABASE_URL: databaseUrl,
  APP_BASE_URL: baseUrl,
  BETTER_AUTH_SECRET: "local-stack-secret-not-for-real-use-0123456789",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  ALLOWED_EMAIL_DOMAINS: "example.com",
  DEV_LOGIN_ENABLED: "true",
  SEND_MODE: "disabled",
  LOG_LEVEL: "info",
  BUILD_ID: process.env.BUILD_ID ?? "local-stack",
  HEARTBEAT_INTERVAL_MS: "5000",
  PORT: String(appPort),
  // M2: CRM against the local mock Notion server (synthetic data, loopback only).
  NOTION_MODE: "mock",
  NOTION_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
  NOTION_MOCK_PORT: String(mockPort),
  NOTION_AUTHORIZATION_REF: "",
  APP_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  APP_ENCRYPTION_KEY_ID: "k1",
};

const children: ChildProcess[] = [];
const bin = (p: string) => path.resolve("node_modules", p);

function run(name: string, args: string[], env: NodeJS.ProcessEnv, opts: { capture: boolean }) {
  const child = spawn(process.execPath, args, { env, stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (opts.capture) {
    const out = fs.createWriteStream(path.join(logDir, `${name}.log`));
    child.stdout!.pipe(out);
    child.stderr!.pipe(out);
  }
  children.push(child);
  return child;
}

function waitExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

async function waitHealthy(timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      last = `${r.status} ${await r.text()}`;
      if (r.status === 200) return;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`stack did not become healthy: ${last}`);
}

const pg = await startLocalPostgres({ dir: `.local/pg-stack-${pgPort}`, port: pgPort, ephemeral: true, quiet: true });
let exitCode = 1;
try {
  await pg.ensureDatabase(dbName);
  await migrateDatabase(databaseUrl);
  console.log(`[stack] postgres ready on ${pgPort}; logs in ${logDir}`);

  // Seed staff fixtures (clearly fake example.com addresses).
  const seed = run(
    "seed",
    [bin("tsx/dist/cli.mjs"), "scripts/seed-fixtures.ts"],
    { ...appEnv, LOG_LEVEL: "silent" },
    { capture: true },
  );
  if ((await waitExit(seed)) !== 0) throw new Error("seeding failed (see seed.log)");

  if (build) {
    console.log("[stack] building web app (next build)…");
    const b = run("build", [bin("next/dist/bin/next"), "build"], appEnv, { capture: true });
    if ((await waitExit(b)) !== 0) throw new Error("next build failed (see build.log)");
  }
  run("notion-mock", [bin("tsx/dist/cli.mjs"), "scripts/notion-mock/server.ts"], appEnv, { capture: true });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${mockPort}/__mock/pages`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 60) throw new Error("mock Notion server did not start (see notion-mock.log)");
    await new Promise((r) => setTimeout(r, 500));
  }
  run("web", [bin("next/dist/bin/next"), "start", "--port", String(appPort)], { ...appEnv, SERVICE_NAME: "web" }, { capture: true });
  run("worker", [bin("tsx/dist/cli.mjs"), "src/worker/main.ts"], { ...appEnv, SERVICE_NAME: "worker" }, { capture: true });
  await waitHealthy();
  console.log(`[stack] web + worker healthy at ${baseUrl}`);

  const [exe, ...rest] = cmd;
  const target = exe === "playwright" ? [bin("@playwright/test/cli.js"), ...rest] : exe === "tsx" ? [bin("tsx/dist/cli.mjs"), ...rest] : [exe, ...rest];
  const c = spawn(process.execPath, target, {
    env: { ...appEnv, E2E_BASE_URL: baseUrl, STACK_LOG_DIR: logDir, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "0" },
    stdio: "inherit",
  });
  exitCode = await waitExit(c);
} catch (e) {
  console.error("[stack]", e instanceof Error ? e.message : e);
  exitCode = 1;
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  await new Promise((r) => setTimeout(r, 1000));
  await pg.stop().catch(() => {});
  console.log(`[stack] stopped (exit ${exitCode})`);
  process.exit(exitCode);
}
