// Clears the scratch folders earlier Vitest runs leaked into the system temp
// directory (#3671). Runs ONCE per run, in the main process, before any test
// file — unlike the `setupFiles`, which run in every worker and whose order is
// load-bearing. This file has no ordering relationship with them.
//
// Vitest writes each run's transformed modules to `os.tmpdir()/<nanoid>/ssr/`
// and only removes that folder in `close()`, silently, so every killed or
// interrupted run — and every run where Windows refuses the delete because a
// worker still holds a file — leaves 100–160 MB behind. The guards (nanoid name,
// real `ssr/` directory, untouched for two hours, never a link, never this
// run's own folder) live with the sweep in `scripts/lib/vitest-temp-sweep.ts`.
//
// The sweep runs in the background so tests start at once; teardown stops it
// after the folder in progress, so it never holds the process open. A heartbeat
// keeps this run's own folders fresh for as long as the run lives, which is
// what protects a long watch-mode session from a sweep started by another run.
import { tmpdir } from "node:os";

import type { TestProject } from "vitest/node";

import {
  STALE_AFTER_MS,
  startVitestTempSweep,
} from "./scripts/lib/vitest-temp-sweep";

/** Every scratch folder this run owns: each project's, plus the instance's own. */
function ownTempDirs(project: TestProject): string[] {
  const dirs = new Set<string>([project.tmpDir]);
  for (const other of project.vitest.projects) dirs.add(other.tmpDir);
  // `_tmpDir` is marked internal, so it is read defensively rather than typed.
  const instanceDir: unknown = Reflect.get(project.vitest, "_tmpDir");
  if (typeof instanceDir === "string") dirs.add(instanceDir);
  return [...dirs];
}

export default function setup(project: TestProject) {
  const sweep = startVitestTempSweep({
    tempRoot: tmpdir(),
    maxAgeMs: STALE_AFTER_MS,
    now: () => Date.now(),
    keep: ownTempDirs(project),
  });
  return async () => {
    await sweep.stop();
  };
}
