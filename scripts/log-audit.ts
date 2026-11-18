/**
 * M8 PII check over stack logs: fails (exit 1) when an unmasked email address appears in any
 * web/worker/notion-mock log under the given directories. Masked forms (`a***@domain`) are fine.
 *
 *   tsx scripts/log-audit.ts <dir> [<dir>…]
 */
import fs from "node:fs";
import path from "node:path";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: tsx scripts/log-audit.ts <dir> [<dir>…]");
  process.exit(2);
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
let files = 0;
const leaks: string[] = [];
for (const d of dirs) {
  for (const name of ["web.log", "worker.log", "notion-mock.log"]) {
    const f = path.join(d, name);
    if (!fs.existsSync(f)) continue;
    files++;
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(EMAIL)) {
      if (/\*\*\*@/.test(m[0])) continue;
      leaks.push(`${f}: ${m[0].replace(/^(.).*@/, "$1***@")}`); // report masked, never echo the address
    }
  }
}
console.log(`log audit: ${files} log file(s) scanned, ${leaks.length} unmasked address(es)`);
if (leaks.length) {
  console.log([...new Set(leaks)].slice(0, 20).join("\n"));
  process.exit(1);
}
if (!files) {
  console.error("no log files found (nothing was checked)");
  process.exit(1);
}
