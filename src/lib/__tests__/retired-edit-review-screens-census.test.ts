import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
const SRC = resolve(ROOT, "src");

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
];

function productionSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(SRC);
  return found;
}

/** Every module specifier a file imports or re-exports from, statically or dynamically. */
function importedSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

describe("the officer edit review's screens stay retired (#4344)", () => {
  it("no retired route directory exists again", () => {
    const back = RETIRED_ROUTE_DIRS.filter((dir) => existsSync(resolve(ROOT, dir)));
    expect(
      back,
      `#4344: these routes answered screens retired with the officer review. Remove them again: ${back.join(", ")}`,
    ).toEqual([]);
  });

  it("no production file imports a retired module", () => {
    const retired = new Set(RETIRED_MODULES);
    const offenders: string[] = [];
    for (const file of productionSources()) {
      for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
        if (retired.has(specifier)) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
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
      importedSpecifiers(
        [
          'import { A } from "@/lib/stored-night-price-repair-queue";',
          'import type { B } from "@/components/admin/hand-back-method-choice";',
          'export { C } from "@/lib/stored-night-price-strand-reconcile";',
          'import "@/components/admin/unpriced-night-price-fields";',
          'const d = await import("@/components/admin/manual-refund-task-still-owed-notice");',
        ].join("\n"),
      ),
    ).toEqual([
      "@/lib/stored-night-price-repair-queue",
      "@/components/admin/hand-back-method-choice",
      "@/lib/stored-night-price-strand-reconcile",
      "@/components/admin/unpriced-night-price-fields",
      "@/components/admin/manual-refund-task-still-owed-notice",
    ]);
    // And it is pointed at a tree that really holds production sources.
    expect(productionSources().length).toBeGreaterThan(500);
  });
});
