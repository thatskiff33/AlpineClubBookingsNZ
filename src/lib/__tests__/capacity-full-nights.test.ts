import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getCapacityFullNights } from "@/lib/capacity-full-nights";
import { parseDateOnly } from "@/lib/date-only";

/**
 * #2930 — the night list a capacity refusal carries.
 *
 * THE DEFECT THIS EXISTS TO CATCH. `getCapacityFullNights` used to filter
 * `availableBeds < 0` alone. A whole-lodge-held night is PINNED to exactly 0
 * available beds and never goes negative — that pin is deliberate, because it
 * keeps a held night out of the admin over-capacity confirm set (`INV-CAP-021`,
 * ADR-001 decision 5) — so a refusal caused only by a hold produced an EMPTY
 * night list while genuine fullness produced a populated one. Two different
 * answers to the one question decision 6 says a member must never be able to
 * ask, visible in the 409 body before a pixel was drawn, and visible again in
 * the member wizard as the sentence "is at capacity on 0 nights".
 */

const HELD = (date: string) => ({
  date: parseDateOnly(date),
  // What the engine reports for a held night: a full lodge, zero free beds,
  // and the flag. Never a negative number.
  availableBeds: 0,
  wholeLodgeHeld: true,
});

const OVER_CAPACITY = (date: string, short: number) => ({
  date: parseDateOnly(date),
  availableBeds: -short,
  wholeLodgeHeld: false,
});

const FITS = (date: string, free: number) => ({
  date: parseDateOnly(date),
  availableBeds: free,
  wholeLodgeHeld: false,
});

describe("getCapacityFullNights — a held night is a full night (#2930)", () => {
  it("names a night the proposal cannot fit on", () => {
    expect(
      getCapacityFullNights([FITS("2026-08-01", 4), OVER_CAPACITY("2026-08-02", 1)]),
    ).toEqual(["2026-08-02"]);
  });

  it("names a whole-lodge-held night, whose availableBeds is 0 rather than negative", () => {
    expect(getCapacityFullNights([HELD("2026-08-02")])).toEqual(["2026-08-02"]);
  });

  it("does NOT name a night that merely reaches exactly zero free beds", () => {
    // The boundary that makes the held case non-obvious: a night landing on
    // exactly 0 with the proposal already subtracted still FITS. Only the hold
    // turns a 0 into a refusal, which is why the flag has to be read and the
    // number alone cannot carry it.
    expect(getCapacityFullNights([FITS("2026-08-02", 0)])).toEqual([]);
  });

  it("gives a hold-only refusal and a genuine-fullness refusal the SAME list", () => {
    // The privacy property stated as an equality rather than as two separate
    // expectations, because what matters is that a reader cannot tell them
    // apart — not that each is individually plausible.
    const heldRefusal = getCapacityFullNights([
      FITS("2026-08-01", 9),
      HELD("2026-08-02"),
      HELD("2026-08-03"),
    ]);
    const fullRefusal = getCapacityFullNights([
      FITS("2026-08-01", 9),
      OVER_CAPACITY("2026-08-02", 2),
      OVER_CAPACITY("2026-08-03", 5),
    ]);
    expect(heldRefusal).toEqual(fullRefusal);
    expect(heldRefusal).toEqual(["2026-08-02", "2026-08-03"]);
  });

  it("never leaks the SHORTFALL, which would tell the two apart by arithmetic", () => {
    // A held night has no meaningful shortfall (the lodge is not oversold, it is
    // reserved), so any list carrying per-night bed numbers would distinguish
    // them even while both are "full". The list is dates and nothing else.
    const nights = getCapacityFullNights([
      HELD("2026-08-02"),
      OVER_CAPACITY("2026-08-03", 7),
    ]);
    for (const night of nights) {
      expect(typeof night).toBe("string");
      expect(night).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("treats an absent flag as not held, so a narrowed row shape is no worse than before", () => {
    expect(
      getCapacityFullNights([
        { date: parseDateOnly("2026-08-02"), availableBeds: 0 },
        { date: parseDateOnly("2026-08-03"), availableBeds: -1 },
      ]),
    ).toEqual(["2026-08-03"]);
  });
});

/**
 * The SSOT half of the same fix, and it is a disk scan on purpose.
 *
 * Five byte-identical copies of this predicate is how one defect became five
 * (`INV-SSOT-001`). A census that only imported the canonical helper could not
 * see a sixth copy reappearing beside it, because a copy has no import edge to
 * the thing it copies — which is exactly the class `npm run test:related` is
 * blind to and this file is therefore in `test:named` territory.
 */
describe("there is exactly one definition of the capacity full-night list", () => {
  it("no module re-declares it", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        if (full.endsWith(join("lib", "capacity-full-nights.ts"))) continue;
        const source = readFileSync(full, "utf8");
        if (/function\s+getCapacityFullNights\s*\(/.test(source)) {
          offenders.push(full);
        }
      }
    };
    walk(root);

    expect(
      offenders,
      "INV-SSOT-001: getCapacityFullNights is defined in src/lib/capacity-full-nights.ts " +
        "and imported from there. A second definition is how #2930's hold-privacy leak " +
        "reached five call sites at once — import it instead of copying it.",
    ).toEqual([]);
  });
});
