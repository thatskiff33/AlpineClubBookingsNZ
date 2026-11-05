// Mutation testing of the ledger, refund and settlement modules (#4459,
// programme #4450). Run it on demand with `pnpm run mutation`, or in the
// `Money mutation` workflow, which runs nightly and on `workflow_dispatch` and
// is never a pull-request check. `docs/TESTING.md` -> "Coverage and mutation
// testing of the money modules" says how to read the report.
import { readFileSync } from "node:fs";

import { MUTATION_TARGET_GLOBS } from "./scripts/lib/money-modules.mjs";

const baseline = JSON.parse(
  readFileSync(new URL("./scripts/ci/money-test-baseline.json", import.meta.url), "utf8"),
);

const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.mts" },
  mutate: [...MUTATION_TARGET_GLOBS],
  // Each mutant re-runs only the tests that executed the mutated line.
  coverageAnalysis: "perTest",
  // Mutants in a constant evaluated once at import are not worth a run each.
  ignoreStatic: true,
  reporters: ["clear-text", "progress", "html", "json"],
  // The table only: the default also prints every test that ran for each mutant.
  clearTextReporter: { allowColor: false, logTests: false },
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  // The sandbox is a copy of the working tree, so without this a local run
  // copies agent worktrees, deployment secrets and build output into it. Only
  // what is large, generated or private is listed: `src/generated/prisma` and
  // `.github/CODEOWNERS` (which `money-modules.mjs` reads) are needed there.
  ignorePatterns: [
    ".claude",
    ".artifacts",
    ".next",
    "out",
    "build",
    "coverage",
    ".vitest",
    "reports",
    "playwright-report",
    "test-results",
    "e2e/.auth",
    "logs",
    "seeds",
    "config/club.json",
    ".env*",
    "*.pem",
    ".vercel",
  ],
  // `break` is the ratchet: a run scoring below the committed baseline fails.
  // It is read from the one baseline file, so raising it is that file's edit.
  thresholds: { high: 85, low: 70, break: baseline.mutation.breakBelowPercent },
  // A mutant that makes a planner loop forever (the settlement chain walker
  // does when its key stops advancing) is reported as a timeout, which counts
  // as detected.
  timeoutMS: 20000,
  timeoutFactor: 2,
  // Only the TypeScript sources are mutated; the default (every file) tries to
  // parse the repository's HTML and warns.
  disableTypeChecks: "src/**/*.ts",
};

export default config;
