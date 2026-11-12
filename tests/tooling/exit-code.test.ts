/**
 * Regression coverage for the test-runner exit-code defect found in M2 (report F4):
 * embedded-postgres → async-exit-hook called process.exit(0) on `beforeExit`, so a FAILING
 * Vitest run exited 0; after removing that hook its `exit` hook threw "done is not a function"
 * and a PASSING run exited 1. The fix lives in scripts/lib/embedded-pg.ts.
 *
 * Each case runs a separate Vitest process on a fixture test and checks the real exit code.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runFixture(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "tests/tooling/fixtures/vitest.fixture.config.ts"], {
    env: { ...process.env, ...env, VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined, NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 180_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("test-runner exit codes (with the project's embedded-postgres helper)", () => {
  it("a deliberately failing test exits non-zero", () => {
    const r = runFixture({ FIXTURE_MODE: "fail", FIXTURE_SETUP: "fixed" });
    expect(r.out).toMatch(/1 failed/);
    expect(r.code).not.toBe(0);
  });

  it("a passing test exits 0", () => {
    const r = runFixture({ FIXTURE_MODE: "pass", FIXTURE_SETUP: "fixed" });
    expect(r.out).toMatch(/1 passed/);
    expect(r.code).toBe(0);
  });

  it("with a real Postgres started and stopped: failing → non-zero, passing → 0 (no 'done is not a function')", () => {
    const fail = runFixture({ FIXTURE_MODE: "fail", FIXTURE_SETUP: "fixed", FIXTURE_START_PG: "1", FIXTURE_PG_PORT: "54341" });
    expect(fail.code).not.toBe(0);
    const pass = runFixture({ FIXTURE_MODE: "pass", FIXTURE_SETUP: "fixed", FIXTURE_START_PG: "1", FIXTURE_PG_PORT: "54342" });
    expect(pass.out).not.toMatch(/done is not a function/);
    expect(pass.code).toBe(0);
  });
});

describe("characterization of the upstream defect (documents why the workaround exists)", () => {
  it("importing embedded-postgres directly makes a FAILING run exit 0", () => {
    // If this ever starts exiting non-zero, upstream fixed the hook and the workaround in
    // scripts/lib/embedded-pg.ts can be re-evaluated. It does not affect product behaviour.
    const r = runFixture({ FIXTURE_MODE: "fail", FIXTURE_SETUP: "raw" });
    expect(r.out).toMatch(/1 failed/);
    expect(r.code).toBe(0);
  });
});
