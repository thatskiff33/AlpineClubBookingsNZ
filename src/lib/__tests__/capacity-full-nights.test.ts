import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { stripComments } from "./support/strip-comments";
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

  /**
   * The fix round's guard, and it lives in the TYPE rather than in an
   * assertion (`INV-SSOT-001`, "prefer unrepresentable over policed").
   *
   * `wholeLodgeHeld` was optional here, on the stated belief that three
   * historic call sites passed a narrowed row. None does — all ten production
   * call sites hand over `NightAvailability` rows from the capacity engine. So
   * the only caller the optional arm ever served was a test written because the
   * field was optional, while the arm itself kept the leak reachable: narrow the
   * row to `date` and `availableBeds` and the call compiled, read absent as "not
   * held", and returned the pre-#2930 list with every held night dropped.
   *
   * This line fails CI in BOTH directions. Put the `?` back and the error
   * disappears, which makes this an UNUSED `@ts-expect-error` — an error of its
   * own. There is no edit to `capacity-full-nights.ts` or to
   * `NightAvailability` that leaves this file compiling and the mandate gone.
   */
  it("refuses a narrowed row that has lost the held flag — at the type layer", () => {
    const narrowed = [
      { date: parseDateOnly("2026-08-02"), availableBeds: 0 },
      { date: parseDateOnly("2026-08-03"), availableBeds: -1 },
    ];

    // @ts-expect-error - `wholeLodgeHeld` is required, precisely so a row that
    // cannot answer "is this night held?" cannot reach the predicate at all.
    const named = getCapacityFullNights(narrowed);

    // Types are erased, so this records what such a caller WOULD get if one
    // reached here through JavaScript or a cast: the held night at exactly zero
    // silently dropped, which is the leak. The compiler is the guard; this is
    // the reason it has to be.
    expect(named).toEqual(["2026-08-03"]);
  });
});

/**
 * The SSOT half of the same fix, and it is a disk scan on purpose.
 *
 * WHAT WAS ACTUALLY IN THE TREE, re-measured against `origin/epic/2725-mad`
 * rather than carried from the first draft, which said "five byte-identical
 * copies" and was wrong in both directions.
 *
 * Eleven non-test files under `src/` spelled `availableBeds < 0`:
 *
 * - FOUR named definitions of `getCapacityFullNights` — `booking-create-guests.ts`,
 *   `booking-request-quotes.ts`, `booking-request-shared.ts`, `group-booking.ts` —
 *   reached from EIGHT call sites across five modules (`booking-create.ts` twice,
 *   `booking-request-quotes.ts`, `booking-request.ts`, `group-booking.ts`, and
 *   `school-booking-request.ts` three times, importing the third definition
 *   rather than holding a fifth);
 * - SIX inline re-spellings under no name at all — the three admin overbook
 *   routes, `group-settlement.ts`, the member `price-summary-card.tsx`
 *   shortfall list and the edit panel's over-capacity list. The booking-edit
 *   QUOTE route is not one of them: it projected the bed numbers and let the
 *   card compare them, which is why a census over this comparison alone would
 *   not have found that half of the leak;
 * - and ONE that is a different rule with the same shape,
 *   `overCapacityNights` in `over-capacity-confirmation.ts`, which adds
 *   `&& !night.wholeLodgeHeld`.
 *
 * Two survive: this predicate and that one. Everything else imports one of them.
 *
 * A census that only imported the canonical helper could not see any of that,
 * because a copy has no import edge to the thing it copies — which is exactly
 * the class `npm run test:related` is blind to, and why this file is in
 * `test:named` territory.
 */
describe("the capacity refusal is spelled in exactly two files — TEXT scan of src, scripts and e2e, blind to a renamed field or a runtime-built copy (#2930)", () => {
  /** Every tracked TypeScript tree a copy could hide in. */
  const TREES = ["src", "scripts", "e2e"];

  /**
   * The two modules allowed to spell the comparison, and what each one means.
   * Held nights are the difference: this one counts them as full, that one
   * excludes them because no admin override may reach one (`INV-CAP-021`,
   * ADR-001 decisions 5 and 6). Never negotiable, never distinguishable.
   */
  const CANONICAL = [
    join("src", "lib", "capacity-full-nights.ts"),
    join("src", "lib", "over-capacity-confirmation.ts"),
  ];

  function sourceFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        found.push(full);
      }
    };
    for (const tree of TREES) {
      const root = join(process.cwd(), tree);
      if (!existsSync(root)) continue;
      walk(root);
    }
    return found;
  }

  /**
   * THE COMPARISON ITSELF, not the name it is given.
   *
   * The first version of this census matched `function getCapacityFullNights(`
   * and nothing else, while its title claimed to prove there was exactly one
   * definition. A same-named arrow function defeated it, a renamed copy defeated
   * it, and — the shape that actually happened here — an inline
   * `.filter(n => n.availableBeds < 0)` at a call site defeated it completely.
   * Six of those were live in the tree while that census passed.
   *
   * Comments are blanked first (`INV-SSOT-004`'s one stripper), so the prose
   * above and in the modules themselves can quote the defect without tripping
   * the guard that catches it.
   */
  it("no other module compares availableBeds against zero BY THAT SPELLING", () => {
    const offenders = sourceFiles().filter((file) => {
      if (CANONICAL.some((canonical) => file.endsWith(canonical))) return false;
      return /availableBeds\s*[<>]=?\s*0/.test(
        stripComments(readFileSync(file, "utf8")),
      );
    });

    expect(
      offenders,
      "INV-SSOT-001: the nights a capacity refusal names are decided in " +
        "src/lib/capacity-full-nights.ts (held nights INCLUDED, for a member) and " +
        "src/lib/over-capacity-confirmation.ts (held nights EXCLUDED, for an admin " +
        "override). Import one of them. #2930's hold-privacy leak reached eleven " +
        "files at once because this comparison was written out by hand at each of " +
        "them, and a held night sits at exactly 0 rather than below it — so every " +
        "copy silently dropped the held nights from the list it was building.",
    ).toEqual([]);
  });

  /**
   * The name, still — because the two guards fail differently and say different
   * things. This one catches a genuine re-declaration that happens to avoid the
   * comparison (delegating to a copied helper, say); the one above catches a
   * copy under any other name.
   *
   * WIDENED to the declaration forms that are really equivalent: a `function`
   * declaration, a `const`/`let`/`var` bound to an arrow or a function
   * expression, and an object-literal or class method. It still matches TEXT, so
   * a copy assembled at runtime or produced by a code generator is out of its
   * reach — mutation-verified: `const getCapacityFullNights = (n) => []` and
   * `getCapacityFullNights(n) { return []; }` both fail it now, where both
   * passed the name-only predecessor.
   */
  it("nothing re-declares getCapacityFullNights under that name, in any declaration form this scan knows", () => {
    const DECLARATION =
      /(?:function\s+getCapacityFullNights\s*[(<]|(?:const|let|var)\s+getCapacityFullNights\s*(?::[^=]+)?=|^\s*(?:async\s+)?getCapacityFullNights\s*[(<])/m;

    const offenders = sourceFiles().filter(
      (file) =>
        !file.endsWith(join("src", "lib", "capacity-full-nights.ts")) &&
        DECLARATION.test(stripComments(readFileSync(file, "utf8"))),
    );

    expect(
      offenders,
      "INV-SSOT-001: getCapacityFullNights is defined in " +
        "src/lib/capacity-full-nights.ts and imported from there.",
    ).toEqual([]);
  });
});
