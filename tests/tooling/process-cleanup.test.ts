/**
 * Regression coverage for M2 report F7 (leftover processes): cleanup must stop the processes a
 * run started INCLUDING their children (grandchildren), and must not touch anything else.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOwned, isAlive, ownedPids, spawnOwned } from "../../scripts/lib/owned-processes";

const bystanders: ChildProcess[] = [];
afterEach(() => {
  for (const b of bystanders.splice(0)) {
    try {
      b.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

function grandchildPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = /GRANDCHILD (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", () => reject(new Error("fixture exited early")));
  });
}

describe("owned-process cleanup", () => {
  it("stops an owned process and its grandchild, and leaves an unrelated process running", async () => {
    const parent = spawnOwned("tree", process.execPath, [path.resolve("tests/tooling/fixtures/spawn-tree.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
    const grand = await grandchildPid(parent);
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    bystanders.push(bystander);
    expect(isAlive(parent.pid!)).toBe(true);
    expect(isAlive(grand)).toBe(true);
    expect(ownedPids()).toContain(parent.pid);
    expect(ownedPids()).not.toContain(bystander.pid);

    const r = await cleanupOwned();
    expect(r.targeted).toEqual(expect.arrayContaining([parent.pid, grand]));
    expect(r.targeted).not.toContain(bystander.pid);
    expect(r.targeted).not.toContain(process.pid); // never the test runner itself
    expect(r.survivors).toEqual([]);
    expect(isAlive(parent.pid!)).toBe(false);
    expect(isAlive(grand)).toBe(false);
    expect(isAlive(bystander.pid!)).toBe(true); // not owned → untouched
  });

  it("does nothing when the run owns no processes", async () => {
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    bystanders.push(bystander);
    const r = await cleanupOwned();
    expect(r).toEqual({ targeted: [], survivors: [] });
    expect(isAlive(bystander.pid!)).toBe(true);
  });

  it("only targets the roots it is given (another owned tree is left alone)", async () => {
    const a = spawnOwned("a", process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    const b = spawnOwned("b", process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const r = await cleanupOwned([a.pid!]);
    expect(r.targeted).toContain(a.pid);
    expect(r.targeted).not.toContain(b.pid);
    expect(isAlive(a.pid!)).toBe(false);
    expect(isAlive(b.pid!)).toBe(true);
    await cleanupOwned([b.pid!]);
    expect(isAlive(b.pid!)).toBe(false);
  });
});
