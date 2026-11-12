import { defineConfig } from "vitest/config";

// FIXTURE config: run in a separate Vitest process by tests/tooling/exit-code.test.ts.
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/tooling/fixtures/*.fixture.ts"],
    globalSetup: [process.env.FIXTURE_SETUP === "raw" ? "tests/tooling/fixtures/setup-raw-library.ts" : "tests/tooling/fixtures/setup-fixed.ts"],
    hookTimeout: 120_000,
  },
});
