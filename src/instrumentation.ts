/**
 * Runs once when the Next.js server starts. Validating configuration here makes the web
 * process fail fast on unsafe settings (e.g. SEND_MODE=live outside production) instead of
 * failing on the first request. On invalid configuration the process exits with code 1 so the
 * host (and anyone watching the logs) sees a failed start rather than a silently idle server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getConfig, ConfigError } = await import("./lib/config");
  try {
    const cfg = getConfig();
    const { getLogger } = await import("./lib/logger");
    getLogger().info({ env: cfg.APP_ENV, send_mode: cfg.SEND_MODE, google: cfg.googleEnabled }, "web server configuration validated");
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[startup] ${e.message}`);
      const exit = (globalThis as { process?: { exit?: (code: number) => never } }).process?.exit;
      exit?.(1);
    }
    throw e;
  }
}
