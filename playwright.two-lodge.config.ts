import { defineConfig, devices } from "@playwright/test";

// ADVISORY two-lodge Playwright project (#1568). It drives the SAME staging
// Docker Compose stack as playwright.config.ts, but that stack is prepared
// differently for this run: the demo seed runs with DEMO_SECOND_LODGE=1 (West
// Ridge Hut), the multiLodge module is ON (E2E_ENABLE_MULTI_LODGE=1) and the
// two-lodge fixtures are seeded (E2E_TWO_LODGE=1 → e2e/setup/seed-two-lodge.ts).
// See scripts/e2e-stack.sh and .github/workflows/e2e-two-lodge.yml.
//
// This config is intentionally separate so the blocking suite
// (playwright.config.ts, multiLodge OFF) stays byte-identical: it ignores
// e2e/two-lodge/**, and this config only ever runs those specs.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

export default defineConfig({
  testDir: "./e2e/two-lodge",
  outputDir: "./test-results-two-lodge",
  // Cross-lodge capacity, roster and waitlist assertions share seeded personas
  // and a fixed second lodge, so — like the main suite — they run serially on a
  // single worker to keep every count deterministic.
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
    {
      name: "two-lodge",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
