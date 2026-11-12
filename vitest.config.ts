import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // One throwaway PostgreSQL cluster for the run; each file gets its own database.
          globalSetup: ["tests/integration/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          // Regression tests for the test tooling itself (exit codes, process cleanup).
          name: "tooling",
          include: ["tests/tooling/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 240_000,
        },
      },
    ],
  },
});
