import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. The stack lifecycle is owned by scripts/e2e.sh (compose up →
 * tests → compose down), so there is intentionally NO `webServer` here — we
 * only point at the already-running production single-port build.
 *
 * Override the target with E2E_BASE_URL if the stack runs elsewhere.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3099";

export default defineConfig({
  testDir: "./tests",
  // Sequential on purpose: tests share one throwaway DB and a first-run signup.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        // Auth state (JWT in localStorage) captured by the setup project.
        storageState: ".auth/state.json",
      },
    },
  ],
});
