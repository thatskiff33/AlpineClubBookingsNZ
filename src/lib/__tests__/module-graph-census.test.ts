import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildImportGraph,
  type ImportGraph,
  importCycles,
  resolveSpecifier,
} from "./support/static-import-graph";

/**
 * INV-SSOT-007 (#4930): the module graph's three boundary rules.
 *
 * 1. Production modules form no static value-import cycle. A loop makes load
 *    order depend on which entry point ran first, so a module-level read across
 *    it can crash one cron job or page and not another. Type-only and dynamic
 *    `import()` edges load nothing at module evaluation and are not counted.
 * 2. Nothing imports `@/lib/xero`. It was a compatibility facade over the
 *    focused Xero modules; it hid their real dependency graph and closed one of
 *    the money-core loops, and it is gone. Import the focused module.
 * 3. Nothing under `src/components` imports from `src/app`. A shared component
 *    that reaches into a route folder makes that page a hidden dependency of
 *    every screen rendering the component.
 *
 * Each rule enumerates by path, so two branches adding entries collide on the
 * same lines rather than merging silently (docs/TESTING.md, "Census tests and
 * the merge hazard"). The allowlists only shrink: an entry that no longer
 * matches the tree fails, so a fixed cycle cannot stay excused.
 */

/** Cycles excused until the named issue removes them. Each is its exact, sorted module set. */
const ALLOWED_CYCLES: ReadonlyArray<{ issue: string; modules: readonly string[] }> = [];

const FACADE = "src/lib/xero.ts";
const FACADE_SPECIFIER = "@/lib/xero";

/** Subtrees the walk must reach, so a skipped directory fails by name rather than shrinking the graph. */
const REQUIRED_SUBTREES = ["src/app/", "src/components/", "src/hooks/", "src/lib/", "src/lib/xero-inbound/"];

const graph = buildImportGraph();

function unexcusedCycles(of: ImportGraph): string[][] {
  const allowed = new Set(ALLOWED_CYCLES.map((entry) => entry.modules.join("\n")));
  return importCycles(of.edges).filter((cycle) => !allowed.has(cycle.join("\n")));
}

/** The repo path `specifier`, written in `from`, names (before extension resolution), or null for a package. */
function target(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return path.posix.join(path.posix.dirname(from), specifier);
  return null;
}

/** Every production import of the facade, of any kind: a type import keeps it alive as surely as a value import. */
function facadeImports(of: ImportGraph): string[] {
  return [...of.imports].flatMap(([file, imports]) =>
    imports
      .filter((entry) => {
        const named = target(file, entry.specifier)?.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "").replace(/\/index$/, "");
        return named === FACADE.replace(/\.ts$/, "");
      })
      .map((entry) => `${file}:${entry.line}`),
  );
}

/** Every import, of any kind, from a `src/components` file into `src/app`. */
function componentAppImports(of: ImportGraph): string[] {
  return [...of.imports]
    .filter(([file]) => file.startsWith("src/components/"))
    .flatMap(([file, imports]) =>
      imports
        .filter((entry) => {
          const named = target(file, entry.specifier);
          return named === "src/app" || named?.startsWith("src/app/");
        })
        .map((entry) => `${file}:${entry.line} -> ${entry.specifier}`),
    );
}

/** The census graph with `extra` appended to one file's source; only that file is re-read. */
function graphWith(file: string, extra: string): ImportGraph {
  const text = readFileSync(path.join(process.cwd(), file), "utf8");
  const changed = buildImportGraph([file], () => `${text}\n${extra}\n`);
  return {
    files: graph.files,
    edges: new Map([...graph.edges, ...changed.edges]),
    imports: new Map([...graph.imports, ...changed.imports]),
    unresolved: [...graph.unresolved, ...changed.unresolved],
  };
}

describe("module graph census (#4930, INV-SSOT-007)", () => {
  it("walks every production subtree and resolves every local import", () => {
    for (const subtree of REQUIRED_SUBTREES) {
      expect(graph.files.some((file) => file.startsWith(subtree)), subtree).toBe(true);
    }
    expect(graph.files.some((file) => file.includes("/__tests__/") || /\.test\./.test(file))).toBe(false);
    expect(graph.unresolved).toEqual([]);
    const edgeCount = [...graph.edges.values()].reduce((sum, targets) => sum + targets.length, 0);
    expect(edgeCount).toBeGreaterThan(graph.files.length);
  });

  it("finds no static value-import cycle outside the allowlist", () => {
    expect(unexcusedCycles(graph)).toEqual([]);
  });

  it("keeps every allowlisted cycle real, so the allowlist only shrinks", () => {
    const present = new Set(importCycles(graph.edges).map((cycle) => cycle.join("\n")));
    for (const entry of ALLOWED_CYCLES) {
      expect(entry.issue).toMatch(/^#\d+$/);
      expect([...entry.modules].sort()).toEqual(entry.modules);
      expect(present.has(entry.modules.join("\n")), entry.modules.join(" -> ")).toBe(true);
    }
  });

  it("has no importer of the retired Xero facade, and no facade", () => {
    expect(facadeImports(graph)).toEqual([]);
    expect(graph.files).not.toContain(FACADE);
  });

  it("has no src/components import from a src/app route folder", () => {
    expect(componentAppImports(graph)).toEqual([]);
  });

  describe("mutation probes: each rule fails when its defect is added back", () => {
    // A real edge A -> B outside any cycle; each probe adds some form of B -> A.
    const [from, to] = ["src/lib/booking-cancel.ts", "src/lib/internet-banking-part-payment-at-cancel.ts"];
    const specifier = "@/lib/booking-cancel";
    const closesLoop = (of: ImportGraph) =>
      unexcusedCycles(of).some((cycle) => cycle.includes(from) && cycle.includes(to));

    it("starts from a real edge that closes no loop", () => {
      expect(resolveSpecifier(to, specifier)).toBe(from);
      expect(graph.edges.get(from)).toContain(to);
      expect(closesLoop(graph)).toBe(false);
    });

    it.each([
      ["a named import", `import { cancelBooking } from "${specifier}";`],
      ["a bare side-effect import", `import "${specifier}";`],
      ["a re-export", `export { cancelBooking } from "${specifier}";`],
      ["a star re-export", `export * from "${specifier}";`],
      ["a namespace import", `import * as cancel from "${specifier}";`],
      ["a value import beside a type", `import { cancelBooking, type CancelBookingInput } from "${specifier}";`],
      ["a multi-line block", `import {\n  // the one thing\n  cancelBooking,\n} from\n  "${specifier}";`],
    ])("reports %s as a new cycle", (_label, edge) => {
      expect(closesLoop(graphWith(to, edge))).toBe(true);
    });

    it.each([
      ["import type", `import type { CancelBookingInput } from "${specifier}";`],
      ["inline type specifiers", `import { type CancelBookingInput } from "${specifier}";`],
      ["export type", `export type { CancelBookingInput } from "${specifier}";`],
      ["an import() type", `type T = import("${specifier}").CancelBookingInput;`],
      ["a dynamic import()", `async function late() { return (await import("${specifier}")).cancelBooking; }`],
      ["a commented-out import", `// import { cancelBooking } from "${specifier}";`],
    ])("does not count %s, which loads nothing at module evaluation", (_label, edge) => {
      expect(closesLoop(graphWith(to, edge))).toBe(false);
    });

    it.each([
      ["a value import", `import { callXeroApi } from "${FACADE_SPECIFIER}";`],
      ["a type import", `import type { EntranceFeeContext } from "${FACADE_SPECIFIER}";`],
      ["a dynamic import", `const facade = () => import("${FACADE_SPECIFIER}");`],
      ["a relative re-export", `export { callXeroApi } from "./xero";`],
      ["an explicit JavaScript extension", `import { callXeroApi } from "@/lib/xero.js";`],
      ["a normalized relative import", `import "./nested/../xero.ts";`],
    ])("reports %s of the facade", (_label, spelling) => {
      const file = "src/lib/booking-cancel.ts";
      const added = facadeImports(graphWith(file, spelling)).filter((site) => !facadeImports(graph).includes(site));
      expect(added).toEqual([expect.stringMatching(/^src\/lib\/booking-cancel\.ts:\d+$/)]);
    });

    it.each([
      ["an alias import", `import Page from "@/app/page";`],
      ["a type import", `import type { Metadata } from "@/app/layout";`],
      ["a relative import", `import Page from "../app/page";`],
      ["the route root", `import "@/app";`],
      ["a re-export", `export { default } from "@/app/page";`],
      ["a dynamic import", `const page = () => import("@/app/page");`],
    ])("reports %s from a component into a route folder", (_label, spelling) => {
      const file = "src/components/edit-booking-panel.tsx";
      const before = componentAppImports(graph).length;
      expect(componentAppImports(graphWith(file, spelling))).toHaveLength(before + 1);
    });
  });
});
