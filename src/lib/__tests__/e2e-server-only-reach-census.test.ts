import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, describeTrail, findReach, relative } from "./helpers/import-graph";

/**
 * NOTHING PLAYWRIGHT LOADS MAY REACH A `server-only` MODULE (#5407).
 *
 * `server-only` throws on import under anything but the `react-server`
 * condition, and Playwright loads its config, every spec and everything they
 * import without it. So one helper that reaches the marker kills every spec
 * that imports that helper at module load, before a single test runs, with a
 * message about Client Components that names nothing the spec did. That is
 * how pull request #5462 failed: `e2e/helpers/reset.ts` imported the demo
 * seed's writers, which import `src/lib/password-hashing.ts`, and every spec
 * using `reset.ts` died at load.
 *
 * The CLI census (`cli-server-only-reach-census.test.ts`) can excuse the reach
 * with `--conditions=react-server` on every published invocation. Nothing
 * excuses it here: Playwright exposes no such flag for its own loader, so the
 * rule is absolute. The tsx entrypoints under `e2e/setup` and `e2e/tools` are
 * CLIs started by shell scripts, judged by that other census, and not roots
 * here unless a Playwright-loaded file imports them.
 *
 * Static AND dynamic edges count, as in the CLI census: a lazy
 * `await import(...)` inside a test still runs under the same loader.
 */

const FORBIDDEN = new Set(["server-only"]);

/** What Playwright loads as a test file, under either config. */
const PLAYWRIGHT_TEST_FILE = /\.(spec|setup|pw)\.ts$/;

/** The two Playwright configs; each is loaded by the runner itself. */
const PLAYWRIGHT_CONFIGS = ["playwright.config.ts", "scripts/e2e-contracts/playwright.config.ts"];

/** Directories whose test files Playwright loads. */
const PLAYWRIGHT_DIRECTORIES = ["e2e", "scripts/e2e-contracts"];

function testFilesUnder(directory: string, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      testFilesUnder(full, out);
    } else if (PLAYWRIGHT_TEST_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function playwrightRoots(): string[] {
  const roots = PLAYWRIGHT_DIRECTORIES.flatMap((directory) =>
    testFilesUnder(path.join(REPO_ROOT, directory)),
  );
  for (const config of PLAYWRIGHT_CONFIGS) {
    const absolute = path.join(REPO_ROOT, config);
    if (existsSync(absolute)) roots.push(absolute);
  }
  return roots.sort();
}

const ROOTS = playwrightRoots();

describe("Playwright-loaded files and the `server-only` boundary (#5407)", () => {
  it("found the specs and configs, so an empty census is not a silent pass", () => {
    const relativeRoots = ROOTS.map(relative);
    expect(ROOTS.length, "no Playwright roots were found").toBeGreaterThan(40);
    expect(relativeRoots).toContain("playwright.config.ts");
    expect(relativeRoots).toContain("e2e/auth.setup.ts");
    expect(relativeRoots).toContain("e2e/membership-application.spec.ts");
  });

  it("has no static or dynamic path from any of them to `server-only`", () => {
    const reaching = ROOTS.map((root) => [root, findReach(root, FORBIDDEN)] as const)
      .filter((pair): pair is readonly [string, string[]] => pair[1] !== null)
      .map(([root, trail]) => `${relative(root)}\n    -> ${describeTrail(trail.slice(1))}`);
    expect(
      reaching,
      "Playwright loads these without the react-server condition, so importing " +
        "`server-only` throws at module load and takes down every spec on the path. " +
        "Keep e2e helpers on modules that carry no `server-only` import.",
    ).toEqual([]);
  });

  it("would see the edge if one were added", () => {
    // The search must actually find a path, or a clean result means nothing.
    const hasher = path.join(REPO_ROOT, "src", "lib", "password-hashing.ts");
    expect(findReach(hasher, FORBIDDEN)).toEqual([hasher, "server-only"]);
  });
});
