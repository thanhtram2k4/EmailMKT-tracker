/** Install Playwright's headless Chromium into node_modules (project-local, no global cache). */
import { spawnSync } from "node:child_process";
import path from "node:path";

const r = spawnSync(process.execPath, [path.resolve("node_modules/@playwright/test/cli.js"), "install", "chromium-headless-shell"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
});
process.exit(r.status ?? 1);
