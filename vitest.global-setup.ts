// Starts the sweep of Vitest's leaked temp folders (#3671). This runs once per
// run in the main process, not per test file, so it has no ordering
// relationship with the `setupFiles`. What leaks, what is removed, and every
// guard are explained in `scripts/lib/vitest-temp-sweep.ts`.
import type { TestProject } from "vitest/node";

import { setupVitestTempSweep } from "./scripts/lib/vitest-temp-sweep";

export default function setup(project: TestProject) {
  return setupVitestTempSweep(project);
}
