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
  resolveEffectiveLodgeCapacity,
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

/**
 * Import census (`INV-SSOT-001`).
 *
 * **What this proves:** the server-side resolver and the admin screen's
 * preview both read the rule from `lodge-effective-capacity.ts`, so the
 * explanation an admin sees is produced by the same code the save will run,
 * and a new importer cannot appear unnoticed.
 *
 * **What it does NOT prove:** that no file anywhere re-derives
 * `min(capacity, beds)` by hand without importing anything. A file that never
 * imports the module is invisible to a census of the module's importers. That
 * gap is why the rule is stated in `docs/CAPACITY_MODEL.md` and carries
 * `INV-CAP-003` — a reader is routed to one definition — rather than being
 * left to this list alone.
 */
describe("the effective-capacity rule has one home (INV-SSOT-001)", () => {
  const SRC_ROOT = join(process.cwd(), "src");

  const EXPECTED_IMPORTERS = [
    "src/components/admin/lodge-capacity-guidance.tsx",
    "src/lib/lodge-capacity.ts",
  ] as const;

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
      if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  it("is imported by exactly the server resolver and the admin preview", () => {
    const importers = sourceFiles(SRC_ROOT)
      .filter((file) =>
        /from "@\/lib\/lodge-effective-capacity"/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(process.cwd(), file).split("\\").join("/"))
      .sort();

    expect(importers).toEqual([...EXPECTED_IMPORTERS]);
  });

  it("stays free of Prisma, config and React imports so both sides can read it", () => {
    // The admin screen is a client component; anything heavier than pure
    // arithmetic in here would either break its bundle or push it back to
    // re-deriving the rule locally, which is the drift this module removes.
    const source = readFileSync(
      join(SRC_ROOT, "lib", "lodge-effective-capacity.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
