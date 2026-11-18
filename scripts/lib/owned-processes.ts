/**
 * Track and clean up ONLY the processes a test run started.
 *
 * Why: on Windows, killing a child process does not kill its own children (e.g. `tsx` spawns a
 * second node process; `next dev` spawns `start-server.js`). Orphans then keep ports open and
 * serve stale code to later checks (found in M2; see reports/2026-11-12-m2/report_m2.md, F7).
 *
 * Rules:
 *  - Only PIDs registered here (spawned through `spawnOwned`) and their descendants are targeted.
 *    Nothing is ever killed by name, by port or by command-line pattern.
 *  - Descendants are snapshotted from the OS process table immediately before killing, so a
 *    process that was re-parented elsewhere is not hunted down.
 *  - After cleanup every snapshotted PID is checked; survivors are reported (and fail the run).
 */
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const owned = new Map<number, { name: string; child: ChildProcess }>();

export function spawnOwned(name: string, command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  // On POSIX, a new process group lets us signal the whole tree with kill(-pid).
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  if (child.pid) owned.set(child.pid, { name, child });
  child.on("exit", () => {
    if (child.pid) owned.delete(child.pid);
  });
  return child;
}

export function ownedPids(): number[] {
  return [...owned.keys()];
}

/** Parent → children table from the OS. */
function processTable(): Array<{ pid: number; ppid: number }> {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
      { encoding: "utf8", windowsHide: true },
    );
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((p) => p.length === 2 && Number.isFinite(p[0]))
      .map(([pid, ppid]) => ({ pid, ppid }));
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

/** The given roots plus all their current descendants. */
export function descendantsOf(roots: number[]): number[] {
  const table = processTable();
  const result = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift()!;
    if (result.has(pid)) continue;
    result.add(pid);
    for (const p of table) if (p.ppid === pid && p.pid !== pid) queue.push(p.pid);
  }
  return [...result];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killOne(pid: number) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

export type CleanupResult = { targeted: number[]; survivors: number[] };

/**
 * Kill the given owned roots (default: all registered) and their descendants, leaves first.
 * `beforeKill` lets a caller attempt a graceful stop first (e.g. `pg_ctl stop`).
 */
export async function cleanupOwned(roots: number[] = ownedPids(), opts: { graceMs?: number } = {}): Promise<CleanupResult> {
  if (!roots.length) return { targeted: [], survivors: [] };
  const targeted = descendantsOf(roots);
  // Graceful first on POSIX (process groups); Windows has no catchable SIGTERM for node.
  if (process.platform !== "win32") {
    for (const r of roots) {
      try {
        process.kill(-r, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, opts.graceMs ?? 1500));
  }
  // Leaves first so parents cannot respawn children.
  for (const pid of [...targeted].reverse()) if (isAlive(pid)) killOne(pid);
  const deadline = Date.now() + 5000;
  let survivors = targeted.filter(isAlive);
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    survivors = targeted.filter(isAlive);
  }
  for (const r of roots) owned.delete(r);
  return { targeted, survivors };
}
