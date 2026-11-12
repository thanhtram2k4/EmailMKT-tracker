// FIXTURE for tests/tooling/process-cleanup.test.ts: a parent that starts a grandchild (like
// tsx → node, or next dev → start-server), prints the grandchild's PID, then idles.
import { spawn } from "node:child_process";
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
process.stdout.write(`GRANDCHILD ${g.pid}\n`);
setInterval(() => {}, 1 << 30);
