import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  MULTI_LODGE_DIR,
  PLAYWRIGHT_TEST_FILE,
  PRE_SETUP_DIR,
  notChromiumIgnore,
  parseE2eShard,
  shardTestMatch,
} from "./scripts/ci/e2e-spec-shard.mjs";

// Browser E2E suite for the Critical journeys in docs/END_TO_END_TEST_MATRIX.md.
// It drives the staging Docker Compose stack (docker-compose.staging.yml) seeded
// with prisma/seed.ts + prisma/demo-seed.ts. Run via `pnpm run test:e2e`, which
// prepares the stack and database first; see docs/E2E_PLAYWRIGHT.md.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

// The test directory, resolved from this file rather than the shell's working
// directory: Playwright resolves `testDir` the same way, so the shard
// partition and the `chromium` ignore always point where the tests are, from
// any cwd (#4397).
const E2E_DIR = path.join(__dirname, "e2e");
const specsUnder = (dir: string) => new RegExp(`${dir}/.*\\.spec\\.ts`);

// Multi-lodge coverage (issue #1568; a blocking CI check since #1655) runs as
// a separate opt-in project, seeded with a second active lodge
// (E2E_MULTI_LODGE=1 → e2e/setup/seed-second-lodge.ts). Its specs live under
// e2e/multi-lodge/ and are ALWAYS excluded from the default chromium project
// (testIgnore below), so the default single-lodge suite never runs them. The
// project itself is only added to the config when E2E_MULTI_LODGE is set, so
// the default suite's project list is byte-identical.
const multiLodgeEnabled = process.env.E2E_MULTI_LODGE === "1";

// Specs held out of ONE run, as a comma-separated list of paths relative to
// `testDir`. Set only by .github/workflows/e2e-rollover-proof.yml, which parks
// the runner's clock a month ahead: a spec that drives the app into a real
// outbound TLS call is then met with a certificate that has expired in the
// container's own reckoning, which is an artefact of the shift and not a date
// defect (#3227). Unset in CI and on a laptop, so the projects below are
// unchanged for every ordinary run.
//
// This is config rather than a command-line file filter because a filter cannot
// express it: Playwright runs a project's DEPENDENCIES in full, ignoring the
// filter, so naming `pre-setup/` on the command line pulls the whole `chromium`
// project back in and the exclusion evaporates. `testIgnore` decides what is in
// a project at all, before any filtering, so it holds.
const excludedSpecs = (process.env.E2E_EXCLUDE_SPECS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

// One CI shard of the default suite (#4397): `E2E_SHARD=i/N` gives this run
// its own slice of the `chromium` spec files, on its own stack and database.
// `setup` runs in every shard (each database needs its signed-in personas);
// `pre-setup` runs only in shard 1, still after that shard's `chromium` slice
// and still with nothing after it. Unset (a laptop, the rollover proof, the
// multi-lodge job), the projects below are unchanged.
const shard = parseE2eShard(process.env.E2E_SHARD);
// A shard's slice is decided before E2E_EXCLUDE_SPECS applies, so the two
// together could leave a shard running `setup` alone and passing. Nothing
// combines them today (the rollover proof runs unsharded); refuse it.
if (shard && excludedSpecs.length > 0) {
  throw new Error("E2E_SHARD and E2E_EXCLUDE_SPECS cannot be combined (#4397).");
}
const shardSpecs = shard ? shardTestMatch(E2E_DIR, shard) : null;
const includePreSetup = !shard || shard.index === 1;
// Run once per prepared database (shard 1), before the destructive setup gate.
const includeMobile = !shard || shard.index === 1;

export default defineConfig({
  testDir: E2E_DIR,
  outputDir: "./test-results",
  // Specs share seeded personas and assert on lodge capacity, so they must not
  // interleave. One worker keeps every capacity/conflict assertion deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Retry twice in CI. The server-side keepAliveTimeout raise
  // (KEEP_ALIVE_TIMEOUT=65000 in docker-compose.staging.yml) removes the
  // keep-alive socket-reset race at its source; retries are the pragmatic
  // backstop for any residual transport-level `socket hang up` on a pooled
  // API request. Kept at 0 locally so a real failure surfaces immediately.
  retries: process.env.CI ? 2 : 0,
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
      // The multi-lodge specs need a two-lodge database; keep them out of the
      // default single-lodge project (they only run in the `multi-lodge`
      // project below). Byte-identical for the default suite: this dir is
      // otherwise empty, so the matched spec set is unchanged.
      //
      // pre-setup/ is excluded for a stronger reason: those specs CLOSE the
      // public site for their duration, so they run in their own project after
      // everything else (#2420).
      // Unsharded, Playwright's default test-file shape, stated once so the
      // shard partition and this project agree by construction.
      testMatch: shardSpecs ?? PLAYWRIGHT_TEST_FILE,
      testIgnore: [notChromiumIgnore(E2E_DIR), ...excludedSpecs],
    },
    ...(includeMobile
      ? [{
          name: "mobile",
          use: { ...devices["Pixel 7"] },
          testMatch: /\/(?:member-notices|booking|stripe-payment)\.spec\.ts$/,
          testIgnore: excludedSpecs,
          // Desktop completes first: both projects share module settings and
          // personas. Booking resets its own pending window; Stripe uses
          // disjoint mobile windows and retains its test-key prerequisite.
          dependencies: ["chromium"],
        }]
      : []),
    // The pre-setup gate on the wire (#2420). Runs LAST — `dependencies` on the
    // main project — because it un-completes site-style setup, which makes every
    // public address answer 503 until it restores the row in afterAll. Safe
    // where it sits: workers: 1 and fullyParallel: false mean nothing else is in
    // flight, and nothing follows it. Needs no second stack; it needs
    // E2E_DATABASE_URL, which scripts/e2e-stack.sh exports.
    ...(includePreSetup
      ? [
          {
            name: "pre-setup",
            testMatch: specsUnder(PRE_SETUP_DIR),
            testIgnore: excludedSpecs,
            use: { ...devices["Desktop Chrome"] },
            dependencies: ["chromium", ...(includeMobile ? ["mobile"] : [])],
          },
        ]
      : []),
    // Cross-lodge isolation project — issue #1568, blocking in CI since #1655.
    // Only present when E2E_MULTI_LODGE=1, so the default project list is unchanged.
    // Each spec logs in for itself (like waitlist.spec), so no setup dependency.
    ...(multiLodgeEnabled
      ? [
          {
            name: "multi-lodge",
            testMatch: specsUnder(MULTI_LODGE_DIR),
            testIgnore: excludedSpecs,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
});
