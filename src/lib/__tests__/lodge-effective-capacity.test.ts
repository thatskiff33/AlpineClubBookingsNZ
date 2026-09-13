/**
 * The canonical effective-capacity rule (#2724, `INV-CAP-003`, `INV-SSOT-001`).
 *
 * Two things are pinned here, and they are different in kind:
 *
 * 1. **The rule itself**, case by case against the scenario table published in
 *    `docs/CAPACITY_MODEL.md`. If the table and this suite ever disagree, one
 *    of the two is wrong and both must be read before either is changed.
 * 2. **That the rule has one home**, as an import census over the tree. See
 *    the census block below for exactly what that proves and what it does not.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredCapacityExceedsActiveBeds,
  MAX_CONFIGURED_LODGE_CAPACITY,
  MIN_CONFIGURED_LODGE_CAPACITY,
  parseConfiguredLodgeCapacity,
  resolveEffectiveLodgeCapacity,
  resolvePartnerSharedHeadroom,
  type EffectiveLodgeCapacity,
} from "@/lib/lodge-effective-capacity";

describe("resolveEffectiveLodgeCapacity — the scenario table in docs/CAPACITY_MODEL.md", () => {
  // Columns match the published table: active beds, configured capacity, then
  // the effective capacity and `source` the table says they resolve to. The
  // "Bed Allocation off" rows are the 0-bed rows: the module being off is
  // expressed to this function as an empty bed inventory, which is the whole
  // of what it means here.
  const CASES: ReadonlyArray<{
    readonly label: string;
    readonly activeBedCount: number;
    readonly configuredCapacity: number | null;
    readonly expected: EffectiveLodgeCapacity;
  }> = [
    {
      label: "module off, capacity 30 (self-healed or admin-set)",
      activeBedCount: 0,
      configuredCapacity: 30,
      expected: { capacity: 30, source: "capacity_override" },
    },
    {
      label: "module off, capacity unset (un-backfilled)",
      activeBedCount: 0,
      configuredCapacity: null,
      expected: { capacity: 0, source: "unconfigured_lodge" },
    },
    {
      label: "module on, 0 beds, capacity 30",
      activeBedCount: 0,
      configuredCapacity: 30,
      expected: { capacity: 30, source: "capacity_override" },
    },
    {
      label: "module on, 0 beds, capacity unset",
      activeBedCount: 0,
      configuredCapacity: null,
      expected: { capacity: 0, source: "unconfigured_lodge" },
    },
    {
      label: "40 beds, capacity unset — only an explicit capacity caps",
      activeBedCount: 40,
      configuredCapacity: null,
      expected: { capacity: 40, source: "configured_beds" },
    },
    {
      label: "40 beds, capacity 40 — equal does not cap",
      activeBedCount: 40,
      configuredCapacity: 40,
      expected: { capacity: 40, source: "configured_beds" },
    },
    {
      label: "40 beds, capacity 50 (above beds) — the beds bind (#2724)",
      activeBedCount: 40,
      configuredCapacity: 50,
      expected: { capacity: 40, source: "configured_beds" },
    },
    {
      label: "40 beds, capacity 30 (below beds) — the capacity caps (#1653)",
      activeBedCount: 40,
      configuredCapacity: 30,
      expected: { capacity: 30, source: "capped_beds" },
    },
  ];

  for (const testCase of CASES) {
    it(`resolves ${testCase.label}`, () => {
      expect(
        resolveEffectiveLodgeCapacity({
          configuredCapacity: testCase.configuredCapacity,
          activeBedCount: testCase.activeBedCount,
        }),
      ).toEqual(testCase.expected);
    });
  }

  it("treats an undefined configured capacity exactly as an absent one", () => {
    expect(
      resolveEffectiveLodgeCapacity({
        configuredCapacity: undefined,
        activeBedCount: 40,
      }),
    ).toEqual({ capacity: 40, source: "configured_beds" });
    expect(
      resolveEffectiveLodgeCapacity({
        configuredCapacity: undefined,
        activeBedCount: 0,
      }),
    ).toEqual({ capacity: 0, source: "unconfigured_lodge" });
  });

  it("never resolves above the active bed inventory once beds exist", () => {
    // The safety half of the rule, stated as a property rather than a case:
    // whatever an admin configures, a lodge with beds can never be made
    // bookable past them. This is what makes "accept and warn" safe.
    for (let beds = 1; beds <= 12; beds += 1) {
      for (let configured = 1; configured <= 40; configured += 1) {
        const resolved = resolveEffectiveLodgeCapacity({
          configuredCapacity: configured,
          activeBedCount: beds,
        });
        expect(resolved.capacity).toBeLessThanOrEqual(beds);
        expect(resolved.capacity).toBeLessThanOrEqual(configured);
      }
    }
  });
});

describe("configuredCapacityExceedsActiveBeds — the #2724 explanation trigger", () => {
  it("is true only when an explicit capacity sits strictly above the beds", () => {
    expect(
      configuredCapacityExceedsActiveBeds({
        configuredCapacity: 30,
        activeBedCount: 24,
      }),
    ).toBe(true);
  });

  it("is false at parity, below parity, and with no capacity set", () => {
    expect(
      configuredCapacityExceedsActiveBeds({
        configuredCapacity: 24,
        activeBedCount: 24,
      }),
    ).toBe(false);
    expect(
      configuredCapacityExceedsActiveBeds({
        configuredCapacity: 20,
        activeBedCount: 24,
      }),
    ).toBe(false);
    expect(
      configuredCapacityExceedsActiveBeds({
        configuredCapacity: null,
        activeBedCount: 24,
      }),
    ).toBe(false);
  });

  it("is false with no beds at all — there is nothing for the capacity to exceed", () => {
    // With no bed inventory the configured capacity IS the effective figure
    // (`capacity_override`), so telling an admin it "does not bind yet" would
    // be false. The deliberate capacity-0 state of a lodge configured with
    // neither is a known rough edge tracked on #3407 and is untouched here.
    expect(
      configuredCapacityExceedsActiveBeds({
        configuredCapacity: 30,
        activeBedCount: 0,
      }),
    ).toBe(false);
  });

  it("agrees with the resolver: when it is true, the beds are what bind", () => {
    const input = { configuredCapacity: 30, activeBedCount: 24 };
    expect(configuredCapacityExceedsActiveBeds(input)).toBe(true);
    expect(resolveEffectiveLodgeCapacity(input)).toEqual({
      capacity: 24,
      source: "configured_beds",
    });
  });
});

describe("resolvePartnerSharedHeadroom — the table in docs/CAPACITY_MODEL.md", () => {
  // Columns match the published partner-headroom table, which is why the
  // arithmetic lives beside the effective-capacity rule: it is the SAME
  // capacity-versus-beds relationship, and the admin screen has to preview it
  // to avoid telling an officer the surplus does nothing (#2724/#1745).
  const CASES: ReadonlyArray<{
    readonly activeBedCount: number;
    readonly activeDoubleBedCount: number;
    readonly configuredCapacity: number | null;
    readonly expected: number;
  }> = [
    { activeBedCount: 10, activeDoubleBedCount: 1, configuredCapacity: null, expected: 1 },
    { activeBedCount: 10, activeDoubleBedCount: 2, configuredCapacity: 11, expected: 1 },
    { activeBedCount: 10, activeDoubleBedCount: 2, configuredCapacity: 10, expected: 0 },
    { activeBedCount: 10, activeDoubleBedCount: 2, configuredCapacity: 8, expected: 0 },
    { activeBedCount: 0, activeDoubleBedCount: 0, configuredCapacity: 30, expected: 0 },
  ];

  for (const testCase of CASES) {
    it(`gives ${testCase.expected} slot(s) for ${testCase.activeBedCount} beds / ${testCase.activeDoubleBedCount} doubles / capacity ${testCase.configuredCapacity}`, () => {
      expect(resolvePartnerSharedHeadroom(testCase)).toBe(testCase.expected);
    });
  }

  it("is capped by the doubles, never by the gap alone", () => {
    // 24 beds, 5 doubles, capacity 30: the gap is 6 but only 5 beds can take a
    // second occupant.
    expect(
      resolvePartnerSharedHeadroom({
        activeBedCount: 24,
        activeDoubleBedCount: 5,
        configuredCapacity: 30,
      }),
    ).toBe(5);
  });

  it("THE #2724 HAZARD: lowering the capacity to the bed count zeroes it", () => {
    // This is the reachable harm the screen's explanation must not point at.
    // Same lodge, same beds, same doubles — only the configured figure moves.
    const lodge = { activeBedCount: 24, activeDoubleBedCount: 5 };
    expect(
      resolvePartnerSharedHeadroom({ ...lodge, configuredCapacity: 30 }),
    ).toBe(5);
    expect(
      resolvePartnerSharedHeadroom({ ...lodge, configuredCapacity: 24 }),
    ).toBe(0);
  });

  it("never exceeds either the doubles or the gap, on any input", () => {
    for (let beds = 1; beds <= 10; beds += 1) {
      for (let doubles = 0; doubles <= beds; doubles += 1) {
        for (let configured = 1; configured <= 24; configured += 1) {
          const headroom = resolvePartnerSharedHeadroom({
            activeBedCount: beds,
            activeDoubleBedCount: doubles,
            configuredCapacity: configured,
          });
          expect(headroom).toBeGreaterThanOrEqual(0);
          expect(headroom).toBeLessThanOrEqual(doubles);
          expect(headroom).toBeLessThanOrEqual(Math.max(0, configured - beds));
        }
      }
    }
  });
});

describe("parseConfiguredLodgeCapacity — the save bounds, in one place", () => {
  it("accepts a whole number inside the bounds, at both ends", () => {
    expect(parseConfiguredLodgeCapacity("30")).toEqual({
      kind: "valid",
      capacity: 30,
    });
    expect(
      parseConfiguredLodgeCapacity(String(MIN_CONFIGURED_LODGE_CAPACITY)),
    ).toEqual({ kind: "valid", capacity: MIN_CONFIGURED_LODGE_CAPACITY });
    expect(
      parseConfiguredLodgeCapacity(String(MAX_CONFIGURED_LODGE_CAPACITY)),
    ).toEqual({ kind: "valid", capacity: MAX_CONFIGURED_LODGE_CAPACITY });
  });

  it("reports a cleared field distinctly from a refused one", () => {
    // Clearing the field is how an admin falls back; it is not an error, and
    // the screen has always been silent about it.
    expect(parseConfiguredLodgeCapacity("")).toEqual({ kind: "cleared" });
    expect(parseConfiguredLodgeCapacity("   ")).toEqual({ kind: "cleared" });
  });

  it("refuses both bounds and every non-whole value, naming the range", () => {
    for (const raw of [
      "0",
      "-5",
      "2.5",
      String(MAX_CONFIGURED_LODGE_CAPACITY + 1),
      "abc",
    ]) {
      const parsed = parseConfiguredLodgeCapacity(raw);
      expect(parsed.kind).toBe("invalid");
      expect(parsed.kind === "invalid" && parsed.message).toContain(
        "from 1 to 100,000",
      );
    }
  });
});

/**
 * Import census (`INV-SSOT-001`).
 *
 * **What this proves:** across `src/`, `scripts/` and `e2e/`, the only files
 * reading this module are the ones listed below — so the explanation an admin
 * sees is produced by the same code the save will run, and no new importer can
 * appear unnoticed **in any import form**: the `@/lib/…` alias, a relative
 * path, or a dynamic `import()`. All three had to be matched. The relative
 * sibling form is the dominant convention in `src/lib/` itself, and
 * `lodge-capacity.ts` — the file this census is chiefly about — already uses
 * dynamic `import()` four times for a documented architectural reason. An
 * earlier alias-only version of this census would have failed loudly on an
 * alias-form importer while letting either of those two through in silence,
 * which is the worst possible shape for a guard: strongest-looking exactly
 * where it was blind.
 *
 * **What it does NOT prove:** that no file re-derives `min(capacity, beds)` by
 * hand without importing anything. A census of importers cannot see a file
 * that imports nothing — and, worse, cannot see a hand re-derivation **inside
 * a file it lists as compliant**. One existed: `lodge-capacity.ts` computed
 * the partner-shared headroom from `capacity − activeBedCount` inline while
 * importing the resolver for the base figure, and this census reported it
 * clean. That arithmetic has since moved into the module
 * (`resolvePartnerSharedHeadroom`), but nothing here would catch the next one.
 * That gap is why the rule is stated in `docs/CAPACITY_MODEL.md` and carries
 * `INV-CAP-003` — a reader is routed to one definition — rather than being
 * left to this list alone.
 *
 * Test files are excluded on purpose: a suite reading the module is exercising
 * it, not re-homing the rule.
 */
describe("the effective-capacity rule has one home (INV-SSOT-001)", () => {
  const SCANNED_ROOTS = ["src", "scripts", "e2e"] as const;

  const EXPECTED_IMPORTERS = [
    "src/app/(admin)/admin/lodges/[id]/page.tsx",
    "src/app/api/admin/lodge-settings/route.ts",
    "src/components/admin/lodge-capacity-guidance.tsx",
    "src/lib/lodge-capacity.ts",
  ] as const;

  // Any module specifier naming this module, in any form a bundler resolves:
  //   import … from "@/lib/lodge-effective-capacity"
  //   import … from "./lodge-effective-capacity"
  //   const { … } = await import("../lib/lodge-effective-capacity")
  // Matching the quoted specifier rather than the `from` keyword is what makes
  // the relative and dynamic forms visible.
  const IMPORTS_THE_MODULE =
    /["'][^"'\n]*\blodge-effective-capacity(?:\.[jt]sx?)?["']/;

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") {
          continue;
        }
        found.push(...sourceFiles(full));
        continue;
      }
      if (
        /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) &&
        !/\.test\.[jt]sx?$/.test(entry.name)
      ) {
        found.push(full);
      }
    }
    return found;
  }

  it("is read by exactly the four listed files, in any import form", () => {
    const importers = SCANNED_ROOTS.flatMap((root) =>
      sourceFiles(join(process.cwd(), root)),
    )
      .filter((file) => IMPORTS_THE_MODULE.test(readFileSync(file, "utf8")))
      .map((file) => relative(process.cwd(), file).split("\\").join("/"))
      .sort();

    expect(importers).toEqual([...EXPECTED_IMPORTERS].sort());
  });

  it("would see a relative or dynamic importer, not only an alias one", () => {
    // Mutation-proof for the widening itself: the three forms an importer can
    // take, checked against the matcher directly. The alias-only predicate
    // this replaced passed only the first of them.
    expect(
      IMPORTS_THE_MODULE.test(
        'import { x } from "@/lib/lodge-effective-capacity";',
      ),
    ).toBe(true);
    expect(
      IMPORTS_THE_MODULE.test('import { x } from "./lodge-effective-capacity";'),
    ).toBe(true);
    expect(
      IMPORTS_THE_MODULE.test(
        'const { x } = await import("../lib/lodge-effective-capacity");',
      ),
    ).toBe(true);
    expect(IMPORTS_THE_MODULE.test('import { x } from "@/lib/lodge-capacity";')).toBe(
      false,
    );
  });

  it("stays free of Prisma, config and React imports so both sides can read it", () => {
    // The admin screen is a client component; anything heavier than pure
    // arithmetic in here would either break its bundle or push it back to
    // re-deriving the rule locally, which is the drift this module removes.
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "lodge-effective-capacity.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
