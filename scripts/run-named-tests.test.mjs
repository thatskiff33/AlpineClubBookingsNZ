import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Coverage for `scripts/run-named-tests.mjs` (#3120): the fail-closed wrapper
 * that stands in for `npx vitest run <paths...>` wherever `AGENTS.md` asks a
 * lane to run a disk-scanning census/contract suite by name. Plain vitest
 * silently drops a named path that matches nothing as long as at least one
 * other path matches, so it can report a short count as a clean green run.
 *
 * Each test spawns the real CLI as a child process (not the module's internal
 * functions -- it has none to unit-test; the whole contract is about what the
 * process does) with `cwd` pointed at a throwaway directory made with
 * `mkdtempSync`, never at this repository's own tree. That is deliberate: a
 * fixture file that briefly existed under `src/` would be visible to every
 * other disk-scanning census test running in a sibling worker at the same
 * moment (`docs/TESTING.md`, "What `test:related` does NOT cover"), and this
 * suite's whole point is proving vitest's OWN file-collection behaviour, which
 * needs a real, isolated project root -- not a mocked collector.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "run-named-tests.mjs");

const PASSING_TEST_SOURCE =
  'import { it, expect } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n';

let scratchDir;

afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

function makeScratchDir() {
  scratchDir = mkdtempSync(path.join(tmpdir(), "run-named-tests-"));
  return scratchDir;
}

/** Runs the wrapper with `cwd` set to the scratch dir, so relative fixture names resolve. */
function runWrapper(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("run-named-tests.mjs -- fail-closed wrapper for named vitest paths (#3120)", () => {
  it(
    "runs and passes when every named path exists and matches a real test",
    () => {
      const dir = makeScratchDir();
      writeFileSync(path.join(dir, "a.test.ts"), PASSING_TEST_SOURCE, "utf8");
      writeFileSync(path.join(dir, "b.test.ts"), PASSING_TEST_SOURCE, "utf8");

      const result = runWrapper(["a.test.ts", "b.test.ts"], dir);

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("2 passed");
    },
    20_000,
  );

  it(
    "refuses BEFORE running anything when one named path does not exist, and names it",
    () => {
      const dir = makeScratchDir();
      writeFileSync(path.join(dir, "a.test.ts"), PASSING_TEST_SOURCE, "utf8");

      const result = runWrapper(["a.test.ts", "does-not-exist.test.ts"], dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to run");
      expect(result.stderr).toContain("MISSING: does-not-exist.test.ts");
      // Nothing ran: no vitest banner, no reported file/test count anywhere in
      // the output. A wrapper that refused but still let the real file run
      // would be exactly the silent-partial-run bug this exists to close.
      expect(result.stdout).not.toContain("Test Files");
      expect(result.stdout).not.toContain("passed");
    },
    20_000,
  );

  it("names every absent path, not just the first", () => {
    const dir = makeScratchDir();

    const result = runWrapper(["missing-a.test.ts", "missing-b.test.ts"], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISSING: missing-a.test.ts");
    expect(result.stderr).toContain("MISSING: missing-b.test.ts");
    expect(result.stderr).toContain("2 named path(s) do not exist");
  });

  it(
    "refuses when a named path exists on disk but vitest collects no test from it",
    () => {
      const dir = makeScratchDir();
      writeFileSync(path.join(dir, "a.test.ts"), PASSING_TEST_SOURCE, "utf8");
      // Real file, present on disk, but its name does not satisfy vitest's own
      // test.include glob (no .test./.spec. segment) -- so the disk pre-check
      // above cannot see the problem this catches: vitest never collects it.
      writeFileSync(path.join(dir, "not-a-test.ts"), "export {};\n", "utf8");

      const result = runWrapper(["a.test.ts", "not-a-test.ts"], dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("matched no test");
      expect(result.stderr).toContain("NO MATCH: not-a-test.ts");
      expect(result.stdout).not.toContain("Test Files");
    },
    20_000,
  );

  it("never lets --passWithNoTests reach vitest -- it refuses the invocation outright", () => {
    const dir = makeScratchDir();
    writeFileSync(path.join(dir, "a.test.ts"), PASSING_TEST_SOURCE, "utf8");

    const result = runWrapper(["--passWithNoTests", "a.test.ts"], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--passWithNoTests is not allowed");
    expect(result.stdout).not.toContain("Test Files");
  });

  it("fails closed with a usage message when called with no paths at all", () => {
    const dir = makeScratchDir();

    const result = runWrapper([], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
});
