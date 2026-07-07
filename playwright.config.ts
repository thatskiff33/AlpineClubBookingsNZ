import { defineConfig, devices } from "@playwright/test";

// Browser E2E suite for the Critical journeys in docs/END_TO_END_TEST_MATRIX.md.
// It drives the staging Docker Compose stack (docker-compose.staging.yml) seeded
// with prisma/seed.ts + prisma/demo-seed.ts. Run via `npm run test:e2e`, which
// prepares the stack and database first; see docs/E2E_PLAYWRIGHT.md.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

export default defineConfig({
  testDir: "./e2e",
  // The advisory two-lodge project (#1568) lives in e2e/two-lodge and runs
  // ONLY via playwright.two-lodge.config.ts against a multiLodge=ON stack. It
  // must never join this blocking suite, which proves single-lodge parity with
  // multiLodge OFF; ignoring it keeps that suite's test set unchanged.
  testIgnore: "**/two-lodge/**",
  outputDir: "./test-results",
  // Specs share seeded personas and assert on lodge capacity, so they must not
  // interleave. One worker keeps every capacity/conflict assertion deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Signs in the booking persona once (completing TOTP enrollment on a fresh
    // database) and saves storage state for the booking/payment specs.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
