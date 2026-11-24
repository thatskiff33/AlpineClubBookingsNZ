import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { moduleImports, productionSourceFiles, resolveSpecifier } from "./support/static-import-graph";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * #4344 (wave C1 of #4302): the officer edit review's screens stay retired.
 *
 * The owner removed the officer review "across the whole app" (23 Oct 2026) and
 * the officer night-price tool with it (D6). Wave C1 deleted the screens, the
 * night-price route and the still-owed preview route. The money machinery
 * behind them is wave C3's, so for a while it still compiles - which is exactly
 * when a merge resolving a conflict against an older branch can put a deleted
 * screen or route back without any type error.
 *
 * Two questions, asked of the tree from disk:
 *
 *  1. does a route that answered a retired screen exist again? A Next route is
 *     reached by its path on disk, so nothing imports it and nothing else would
 *     notice;
 *  2. does any production file import a retired module again?
 *
 * `vitest related` cannot reach this file - it reads the tree from disk - so it
 * is selected by name.
 */

const ROOT = process.cwd();

const RETIRED_ROUTE_DIRS = [
  "src/app/api/admin/bookings/[id]/stored-night-prices",
  "src/app/api/admin/payments/manual-refund-tasks/[id]/still-owed",
];

const RETIRED_MODULES = [
  "@/lib/stored-night-price-strand-reconcile",
  "@/lib/stored-night-price-repair-queue",
  "@/components/admin/booking-stored-night-price-controls",
  "@/components/admin/unpriced-night-price-fields",
  "@/components/admin/manual-refund-task-still-owed-notice",
  "@/components/admin/hand-back-method-choice",
  "@/components/admin/manual-refund-settlement-direction",
];

/** `@/lib/x` as the repo path it names, without its extension: `src/lib/x`. */
const RETIRED_MODULE_PATHS = new Map(RETIRED_MODULES.map((module) => [`src/${module.slice(2)}`, module]));

/**
 * The retired module an import names, or null. An `@/` specifier is matched as
 * written, so it is caught whether or not the file is back. A relative one is
 * resolved against the tree, which finds it once the file is back - and until
 * then the import names a file that does not exist, so the build already fails.
 */
function retiredModuleNamedBy(file: string, specifier: string): string | null {
  if (RETIRED_MODULES.includes(specifier)) return specifier;
  if (!specifier.startsWith(".")) return null;
  const resolved = resolveSpecifier(file, specifier);
  return resolved === null ? null : (RETIRED_MODULE_PATHS.get(resolved.replace(/\.[^./]+$/, "")) ?? null);
}

// Parsing every production file takes several seconds on a CI shard - longer
// than the 5s default (the same allowance payment-settler-writer-census takes).
describe("the officer edit review's screens stay retired (#4344)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  // Walked once: the census and its control both read the same list.
  const files = productionSourceFiles();

  it("no retired route directory exists again", () => {
    const back = RETIRED_ROUTE_DIRS.filter((dir) => existsSync(resolve(ROOT, dir)));
    expect(
      back,
      `#4344: these routes answered screens retired with the officer review. Remove them again: ${back.join(", ")}`,
    ).toEqual([]);
  });

  it("no production file imports a retired module", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { specifier } of moduleImports(file, readFileSync(resolve(ROOT, file), "utf8"))) {
        const retired = retiredModuleNamedBy(file, specifier);
        if (retired !== null) {
          offenders.push(`${file} -> ${retired}`);
        }
      }
    }
    expect(
      offenders,
      `#4344: these files import a module retired with the officer review: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("the import scan sees every import shape it claims to", () => {
    // THE CONTROL: a scanner that found nothing would pass the census above.
    expect(
      moduleImports(
        "retired-import-control.ts",
        [
          'import { A } from /* explanatory comment */ "@/lib/stored-night-price-repair-queue";',
          'import type { B } from "@/components/admin/hand-back-method-choice";',
          'export { C } from "@/lib/stored-night-price-strand-reconcile";',
          'import "@/components/admin/unpriced-night-price-fields";',
          'const d = await import(`@/components/admin/manual-refund-task-still-owed-notice`);',
          '// import { ignored } from "@/lib/retired-example";',
          `const example = 'import { ignored } from "@/lib/retired-example"';`,
        ].join("\n"),
      ).map(({ specifier }) => specifier),
    ).toEqual([
      "@/lib/stored-night-price-repair-queue",
      "@/components/admin/hand-back-method-choice",
      "@/lib/stored-night-price-strand-reconcile",
      "@/components/admin/unpriced-night-price-fields",
      "@/components/admin/manual-refund-task-still-owed-notice",
    ]);
    // And it is pointed at a tree that really holds production sources.
    expect(files.length).toBeGreaterThan(500);
    // An alias is caught as written, with no file on disk.
    expect(retiredModuleNamedBy("src/app/page.tsx", "@/lib/stored-night-price-repair-queue")).toBe(
      "@/lib/stored-night-price-repair-queue",
    );
    // A relative import is resolved to the file it names, so a retired module
    // that is back is caught however it is spelled. Shown on kept siblings: the
    // retired files are not on disk to resolve.
    expect(resolveSpecifier("src/lib/stored-night-price-repair-store.ts", "./stored-night-price-repair")).toBe(
      "src/lib/stored-night-price-repair.ts",
    );
    expect(retiredModuleNamedBy("src/lib/stored-night-price-repair-store.ts", "./stored-night-price-repair")).toBeNull();
  });
});
