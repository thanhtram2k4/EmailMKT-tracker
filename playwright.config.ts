import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a stack started by scripts/local-stack.ts (`npm run e2e`),
 * or against an existing environment by setting E2E_BASE_URL.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "on",
    screenshot: "on",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
