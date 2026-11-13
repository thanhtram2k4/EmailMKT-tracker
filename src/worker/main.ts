/** Worker process entry point: `npm run worker`. */
import { loadLocalEnv } from "../../scripts/lib/env-file";
loadLocalEnv();
process.env.SERVICE_NAME ??= "worker";

const { getConfig } = await import("../lib/config");
const { getLogger } = await import("../lib/logger");
const { closeDb } = await import("../lib/db/client");
const { startWorker } = await import("./runner");

const cfg = getConfig(); // fails fast on unsafe configuration (e.g. SEND_MODE=live outside production)
const log = getLogger();
log.info({ env: cfg.APP_ENV, send_mode: cfg.SEND_MODE }, "starting worker");

const handle = await startWorker({
  databaseUrl: cfg.DATABASE_URL,
  concurrency: cfg.WORKER_CONCURRENCY,
  heartbeatIntervalMs: cfg.HEARTBEAT_INTERVAL_MS,
  buildId: cfg.BUILD_ID,
  enableCrmSchedules: cfg.NOTION_MODE !== "disabled",
  enableSendSchedules: true,
});
log.info({ notion_mode: cfg.NOTION_MODE, crm_schedules: cfg.NOTION_MODE !== "disabled" }, "worker schedules configured");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down worker");
  await handle.stop();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
await handle.runner.promise;
