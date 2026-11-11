import fs from "node:fs";
import path from "node:path";

/**
 * Load `.env.local` (then `.env`) for scripts and the worker, mirroring what Next.js does
 * for the web app. Existing process.env values win, so CI/hosting variables are never overridden.
 */
export function loadLocalEnv(root = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      const [, key, raw] = m;
      const value = raw.replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
