import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toSeasonRateData } from "@/lib/policies/booking-route-decisions";

import { blankLiterals, stripComments } from "./support/strip-comments";
import { balancedBrackets } from "./support/balanced-brackets";

/**
 * Census: every loader that feeds an in-progress edit must select the column
 * that says what a night was SOLD for (#2744), and every builder of the plan must
 * hand it the club's group-discount config (#2756).
 *
 * THE FILENAME UNDERSELLS IT, AND IS KEPT ANYWAY. Most of the valued-reader
 * sites below are PRE-check-in paths. A rename would read better and would
 * disarm every path-hardcoded scanner that names this file — including three
 * ways of doing so silently — for no measured benefit. The scope is what the
 * describe blocks say, not what the name says.
 *
 * `buildInProgressGuestRangePlan` credits a night given back at the figure
 * `valueStrandNights` reads from its `BookingGuestNight` row and the guest's
 * stored total (#4317, `INV-MOD-028`). What has NOT changed is that the plan
 * cannot tell "this night has no stored price" from "this query did not ask for
 * it" — both arrive as a row with no `priceCents`, and the valuation then splits
 * the total over it instead of reading the row.
 *
 * So the whole money path still rests on two Prisma selects saying
 * `nights: { select: { stayDate: true, priceCents: true } }`, and the failure
 * mode if one stops is still silent in the type system: `priceCents` is optional
 * on the plan's night type so that a caller holding a bare `Date` compiles, and
 * the plan-level suites build guests by hand while
 * `calculate-modified-pricing-capacity.test.ts` mocks the database.
 *
 * Since #4317 that failure is QUIET again: a trimmed select would value every
 * night by an even split of the guest's total rather than by its row, and the
 * member would be credited the average. So this census still earns its place.
 *
 * Roughly twenty other sites in the tree load `nights: { select: { stayDate:
 * true } }`, because they only need to know which nights a guest holds. A new
 * edit path copying the cheaper one, or somebody trimming a select for
 * performance, is exactly how this comes back. This file makes the inventory
 * mechanical, in the style of `guest-stay-expansion-census.test.ts` and
 * `night-occupancy-census.test.ts`: a new caller of the in-progress plan has to
 * be classified here, and a declared loader has to keep asking for the price.
 *
 * ## What this census does and does not guarantee
 *
 * It is a SOURCE-TEXT census over `src/`. It guarantees that no production call
 * to `buildInProgressGuestRangePlan` or `calculateModifiedPricing` can appear
 * without being declared, that every `nights: { select: … }` inside a
 * declared LOADER asks for `priceCents`, and that every call that BUILDS the plan
 * passes `groupDiscount`. It cannot follow a booking loaded in
 * one file and passed through three others, which is why the table records the
 * route from loader to plan in prose and why `booking-modify-plan.ts` is
 * declared as a `plan-builder` that loads nothing: the check that matters for
 * that file is that its two callers are both on this list.
 *
 * The group-discount half exists for the same reason as the price half: the
 * argument is OPTIONAL on the plan's input, because a club that has not switched
 * the discount on passes nothing, so a caller that drops it type-checks, throws
 * nothing and fails no other test — the only symptom is a member being charged
 * the undiscounted rate for a night an earlier edit would have discounted
 * (INV-MOD-006, #2756). It cannot check that the config passed is the RIGHT one;
 * `groupDiscount` here is the same variable both pricing paths in that file use.
 */

const SRC_ROOT = path.resolve(process.cwd(), "src");

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : allSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

/**
 * Every scanned file paired with its comment-stripped source, computed ONCE.
 *
 * Two censuses below walk the whole of `src/` and strip every file. Doing that
 * twice cost this file its 5-second budget the moment #3164 moved it onto the
 * canonical scanner: a full-tree pass is 366 ms against the 56 ms the two-regex
 * copy took, which is invisible on its own and is not invisible twice over,
 * under the parallel load a real run puts on it. Measured rather than assumed —
 * each of those two tests takes ~450 ms in isolation and both timed out at
 * 5,000 ms when seven suites ran together.
 *
 * Sharing the pass is the fix rather than a longer timeout, because a timeout
 * raised to cover a slower scan hides the NEXT slow thing as well.
 */
let strippedTree: Array<{ absolute: string; code: string }> | null = null;

function strippedSources(): Array<{ absolute: string; code: string }> {
  strippedTree ??= allSourceFiles(SRC_ROOT).map((absolute) => ({
    absolute,
    code: stripComments(fs.readFileSync(absolute, "utf8")),
  }));
  return strippedTree;
}

function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

/**
 * A CALL to either entry point into the in-progress plan.
 *
 * The lookbehind drops the two declarations (`export function
 * buildInProgressGuestRangePlan(`, `export async function
 * calculateModifiedPricing(`) so a definition is not mistaken for a caller. A
 * bare import or re-export has no `(` after the name and never matches, which is
 * deliberate: importing the symbol is not what puts a booking through the plan.
 */
const PLAN_CALL =
  /(?<!function\s)\b(?:buildInProgressGuestRangePlan|calculateModifiedPricing)\s*\(/g;

/** `nights: { select: { … } }`, with the selected fields captured. */
const NIGHTS_SELECT = /nights:\s*\{\s*select:\s*\{([^}]*)\}/g;

/**
 * A call to the plan BUILDER itself — the one whose argument object has to carry
 * the group-discount config (#2756). `calculateModifiedPricing` is deliberately
 * not in it: that function reads the setting and forwards it, and its own callers
 * pass a transaction rather than a config.
 */
const PLAN_BUILDER_CALL = /(?<!function\s)\bbuildInProgressGuestRangePlan\s*\(/g;

function balancedArgumentList(
  source: string,
  openIndex: number,
  structure: string,
): string {
  return balancedBrackets(source, openIndex, structure).text;
}

/**
 * Every production file that puts a booking through the in-progress plan.
 *
 *  - `loader` — reads the booking from the database and hands it to the plan.
 *    Its `nights` select is load-bearing and is checked below.
 *  - `plan-builder` — receives an already-loaded booking and builds the plan
 *    from it. Loads nothing itself, so there is no select to check; it is on the
 *    list so that a THIRD caller of it has to be declared.
 *
 * `calls` is declared rather than counted so that a second call added to a file
 * already here fails the census instead of hiding behind the first.
 * `planBuilderCalls` is the subset of them that build the plan directly and must
 * therefore pass the group discount (#2756).
 */
const PLAN_CALL_SITES = [
  {
    file: "src/lib/booking-batch-modification-service.ts",
    kind: "loader",
    calls: 1,
    what: "the APPLY path: re-reads the booking under the lodge capacity lock, then prices the edit through calculateModifiedPricing",
    // 1 -> 2 (#3530): the second select is the AFTER-side re-read of the guest
    // rows the edit has just written, for the itemised lines the modification
    // row stores; it asks for `priceCents` for the same reason the loader does.
    nightsSelects: 2,
    planBuilderCalls: 0,
  },
  {
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
    kind: "loader",
    calls: 1,
    what: "the QUOTE path: previews the same edit, and must reach the same numbers as the apply path or the member is quoted one price and charged another",
    nightsSelects: 1,
    planBuilderCalls: 1,
  },
  {
    file: "src/lib/booking-modify-plan.ts",
    kind: "plan-builder",
    calls: 1,
    what: "calculateModifiedPricing — builds the plan from the booking its caller loaded",
    nightsSelects: 0,
    planBuilderCalls: 1,
  },
] as const;

describe("in-progress edit sold-price census (#2744)", () => {
  it("declares every production caller of the in-progress plan", () => {
    const found = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          [...fs.readFileSync(absolute, "utf8").matchAll(PLAN_CALL)].length > 0,
      )
      .map(repoRelative)
      .sort();

    expect(found).toEqual(
      PLAN_CALL_SITES.map((site) => site.file as string).sort(),
    );
  });

  it("counts the calls in each declared file, so a second one cannot hide", () => {
    for (const site of PLAN_CALL_SITES) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), site.file),
        "utf8",
      );
      expect([...source.matchAll(PLAN_CALL)].length, site.file).toBe(site.calls);
    }
  });

  it("keeps every loader asking for what each night was sold for", () => {
    for (const site of PLAN_CALL_SITES) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), site.file),
        "utf8",
      );
      const selects = [...source.matchAll(NIGHTS_SELECT)].map((match) =>
        match[1].trim(),
      );

      expect(selects.length, `${site.file} nights selects`).toBe(
        site.nightsSelects,
      );
      for (const select of selects) {
        // INV-MOD-005: without `priceCents` the plan has no sold price to
        // recover and credits the night back at TODAY's season rate instead —
        // silently, with nothing else in the tree going red.
        expect(
          select,
          `${site.file} must select priceCents on the nights relation (INV-MOD-005, #2744)`,
        ).toContain("priceCents");
      }
    }
  });

  it("keeps every builder of the plan passing the club's group discount", () => {
    for (const site of PLAN_CALL_SITES) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), site.file),
        "utf8",
      );
      // Found over masked text: a call named in a comment or string is not one.
      const structure = blankLiterals(source);
      const builderCalls = [...structure.matchAll(PLAN_BUILDER_CALL)];

      expect(builderCalls.length, `${site.file} plan-builder calls`).toBe(
        site.planBuilderCalls,
      );
      for (const call of builderCalls) {
        const openIndex = (call.index ?? 0) + call[0].length - 1;
        // INV-MOD-006: without the config the plan prices the party it is given
        // with no discount at all, so a night an in-progress edit BUYS costs more
        // than the same night bought before the stay began — and nothing else in
        // the tree goes red, because the argument is optional by design (a club
        // that has not switched the discount on passes nothing).
        const argumentList = stripComments(
          balancedArgumentList(source, openIndex, structure),
        );
        expect(
          argumentList,
          `${site.file} must pass groupDiscount to buildInProgressGuestRangePlan (INV-MOD-006, #2756)`,
        ).toContain("groupDiscount");
        // And pass something. A bare `toContain` passes on
        // `groupDiscount: undefined`, which type-checks (the argument is optional),
        // throws nothing and prices every night undiscounted — the defect itself,
        // wearing the name of the fix. Comments are stripped first for the same
        // reason: the modify-quote call site carries a four-line comment INSIDE its
        // argument list, so prose mentioning the field could otherwise satisfy the
        // check on its own.
        expect(
          argumentList,
          `${site.file} must pass a DEFINED groupDiscount, not \`groupDiscount: undefined\` (INV-MOD-006, #2756)`,
        ).toMatch(/\bgroupDiscount\b(?!\s*:\s*(?:undefined|null)\b)/);
      }
    }
  });
});

/**
 * `SeasonRateData.type` — the second optional field the whole #2756 fix rests on,
 * and the one that made the first draft of it INERT.
 *
 * `isGroupDiscountApplicable` tests `findSeasonForDate(night, seasons)?.type ===
 * "SUMMER"` whenever `summerOnly` is set, and `summerOnly` is `true` by
 * `prisma/schema.prisma`'s default, by `DEFAULT_GROUP_DISCOUNT_SETTING` and by the
 * admin section's default — so for the most likely real configuration a season
 * that arrives without its `type` turns the discount OFF. The field is optional on
 * `SeasonRateData`, so a mapping that omits it compiles, throws nothing and fails
 * no unit test: the plan-level suites hand seasons in by hand, so they can only
 * ever prove that pricing HONOURS the field, never that a production loader
 * carries it.
 *
 * That is not hypothetical. Creation, the quote route, booking requests, group and
 * school bookings and the waitlist reprice all mapped through `toSeasonRateData`
 * and carried `type`, while all five EDIT paths hand-rolled their own four-key
 * literal without it — so a default-configured club had its booking discounted
 * when it was made and every later edit priced at the full rate, which is
 * INV-MOD-006's parity claim being false in the exact direction that costs the
 * member money.
 *
 * The guard is therefore two-part: the one mapper must carry the field, and it must
 * stay the ONLY production mapping, because a second one is free to drop it again.
 */
const SEASON_RATE_MAPPER_FILE =
  "src/lib/policies/booking-route-decisions.ts";

/**
 * A season row being mapped into `SeasonRateData` — `seasonId: <something>.id`.
 *
 * Deliberately narrow: it matches the mapping and not the many other uses of the
 * word (`seasonId: string` in a type, `seasonId: true` in a Prisma select,
 * `seasonId: season.seasonId` passing an already-mapped value through).
 */
const SEASON_RATE_MAPPING = /seasonId:\s*[A-Za-z_$][\w$]*\.id\b/g;

/**
 * Files that match the SHAPE above and are not season-rate mappings at all.
 *
 * The pattern keys on `seasonId: <something>.id`, which is also how any record
 * keyed by season is built. Declaring the exceptions by name — rather than
 * loosening the pattern, which would let a real second mapper back in — keeps
 * the assertion an exact equality: a new file matching the shape fails until
 * somebody classifies it as one or the other.
 *
 * Both entries arrived with #2933's missing-rate warning. Neither produces a
 * `SeasonRateData`: they carry no `startDate`, no `endDate` and no season
 * `type`, which is the field this census exists to protect, and neither is ever
 * handed to pricing.
 */
const DECLARED_NON_MAPPINGS = [
  // Keys an existing rate row by its season before asking which rates are
  // missing. Reads `membershipTypeId` and `ageTier`, and no amount at all.
  "src/app/(admin)/admin/fees/_components/hut-fees-section.tsx",
  // The gap record itself: season id and NAME, for a warning to render.
  "src/lib/membership-type-rate-coverage.ts",
];

describe("season rate data census (#2756)", () => {
  it("carries the season type through the one mapper", () => {
    const [mapped] = toSeasonRateData([
      {
        id: "s1",
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-31T00:00:00.000Z"),
        type: "SUMMER",
        membershipTypeRates: [
          { membershipTypeId: "t1", ageTier: "ADULT", pricePerNightCents: 5000 },
        ],
      },
    ]);

    // Without this the group discount is off for every summer-only club, on every
    // path that loads seasons — silently.
    expect(mapped.type).toBe("SUMMER");
  });

  it("keeps that mapper the only production season mapping", () => {
    const found = strippedSources()
      .filter((file) => [...file.code.matchAll(SEASON_RATE_MAPPING)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();

    // A second mapper is how `type` went missing on five edit paths at once. If a
    // new loader needs season rates, call `toSeasonRateData` rather than mapping
    // the rows again — the type system cannot object, because the field is
    // optional.
    expect(found).toEqual(
      [SEASON_RATE_MAPPER_FILE, ...DECLARED_NON_MAPPINGS].sort(),
    );
  });
});


/**
 * #4317 (epic #4302, `INV-MOD-028`): EVERY EDIT DOOR PRICES AN EXISTING GUEST
 * FROM ITS VALUED NIGHTS.
 *
 * The lenient `lockedNightPricesForGuest` is gone. It locked only usable rows,
 * so a night with no usable stored price fell through to today's season rate —
 * on a night the edit was giving BACK as much as on one it was buying — and
 * epic #2797 answered that by parking the edit. #4317 answers it by valuing
 * every held night (`valueStrandNights`) and locking it at that value
 * (`valuedNightLocksForGuest`), so only a night the edit newly buys reaches a
 * season rate. Two things make that hold door by door, and this census measures
 * both, because nothing in the type system objects to a door that skips them:
 *
 *  - the existing party is LOCKED through the valued reader — directly, or
 *    through `editedGuestPricingLocks`, its one wrapper for the modify save,
 *    the modify preview and the edit's promo preview (#3531);
 *  - the engine's breakdown is passed through `withUnattachedStrandMoney`, so
 *    a strand carrying money beyond its night values (a negative stored total,
 *    D11) keeps it and a removed one credits $0.
 *
 * A new door that prices an existing guest with no lock, or skips the
 * unattached money, is how a night given back comes to be credited at today's
 * rate again; a door that raises an `EDIT_FINANCIAL_REVIEW` task is how the
 * retired review comes back. Each must be declared here.
 */
const VALUED_LOCK_CALL_SITES = [
  {
    file: "src/app/api/bookings/[id]/guests/route.ts",
    calls: 1,
    what: "adding a guest: the existing party is locked at its valued nights, so the add costs exactly the added guests",
  },
  {
    file: "src/lib/booking-date-modification-service.ts",
    calls: 1,
    what: "a date change: a night kept across the move keeps its valued price, a night given back is credited at it, and only the new range's nights reach the season table",
  },
  {
    file: "src/lib/booking-guest-removal-service.ts",
    calls: 1,
    what: "the guest removal: every remaining night is locked, so the reprice returns each remaining guest's stored total and the credit is the departing guest's own",
  },
  {
    file: "src/lib/booking-modify-plan.ts",
    calls: 2,
    what: "`editedGuestPricingLocks` (the save's and both previews' one wrapper) and `applyGuestChanges`' rate-snapshot decision, which must see the same locks pricing used",
  },
] as const;

/** A CALL, not the declaration. */
const VALUED_LOCK_CALL = /(?<!function\s)\bvaluedNightLocksForGuest\s*\(/g;

const EDITED_LOCKS_CALL_SITES = [
  "src/app/api/bookings/[id]/modify-quote/route.ts",
  "src/lib/booking-modify-plan.ts",
  "src/lib/promo-preview-stay-ranges.ts",
] as const;
const EDITED_LOCKS_CALL = /(?<!function\s)\beditedGuestPricingLocks\s*\(/g;

/**
 * Every door that writes a new booking total after an edit, and the in-progress
 * planner the quote and save share: each takes it through
 * `editedBookingTotalCents`, so a headline a parked edit froze keeps its gap
 * rather than being settled by the edit (#4317 review H1, `INV-SSOT-001`).
 */
const EDITED_TOTAL_SITES = [
  "src/app/api/bookings/[id]/guests/route.ts",
  "src/app/api/bookings/[id]/modify-quote/route.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-edit-guest-ranges.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-plan.ts",
] as const;
const EDITED_TOTAL_CALL = /(?<!function\s)\beditedBookingTotalCents\s*\(/g;

/**
 * #4317 review round 4: an in-progress edit never re-decides its promotion. It
 * carries the plan's capped figure, and the save scales the stored records to
 * it in ONE place, the in-progress arm of `applyPromoCodeChanges`; the round-3
 * engine re-decision (`inProgressPlanGuestNightRates`) stays deleted.
 */
const CARRIED_CAP_SITES = ["src/lib/booking-modify-plan.ts"] as const;
const CARRIED_CAP_CALL = /(?<!function\s)\bcapCarriedPromotionRecords\s*\(/g;
const RE_DECIDED_PLAN_RATES = /\binProgressPlanGuestNightRates\b/;

/** Every door whose engine breakdown carries a night-less strand's money. */
const UNATTACHED_MONEY_SITES = [
  "src/app/api/bookings/[id]/guests/route.ts",
  "src/app/api/bookings/[id]/modify-quote/route.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-plan.ts",
] as const;
const UNATTACHED_MONEY_CALL = /(?<!function\s)\bwithUnattachedStrandMoney\s*\(/g;

describe("valued locked-night reader census (#4317, INV-MOD-028)", () => {
  it("declares every production caller of the valued reader", () => {
    const found = strippedSources()
      .filter((file) => [...file.code.matchAll(VALUED_LOCK_CALL)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();
    expect(found).toEqual(
      VALUED_LOCK_CALL_SITES.map((site) => site.file as string).sort(),
    );
  });

  it("counts the calls in each declared file, so a second one cannot hide", () => {
    for (const site of VALUED_LOCK_CALL_SITES) {
      const source = stripComments(
        fs.readFileSync(path.resolve(process.cwd(), site.file), "utf8"),
      );
      expect([...source.matchAll(VALUED_LOCK_CALL)].length, site.file).toBe(
        site.calls,
      );
    }
  });

  it("routes the save, the quote and the promo preview through one locks wrapper", () => {
    const found = strippedSources()
      .filter((file) => [...file.code.matchAll(EDITED_LOCKS_CALL)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();
    expect(found).toEqual([...EDITED_LOCKS_CALL_SITES].sort());
  });

  it("moves every edited headline only by the edit's own change (review H1)", () => {
    const found = strippedSources()
      .filter((file) => [...file.code.matchAll(EDITED_TOTAL_CALL)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();
    expect(
      found,
      "#4317 review H1: every edit door takes its new total through editedBookingTotalCents",
    ).toEqual([...EDITED_TOTAL_SITES].sort());
  });

  it("carries and caps an in-progress promotion in one place, and never re-decides it (round 4)", () => {
    const sources = strippedSources();
    const found = sources
      .filter((file) => [...file.code.matchAll(CARRIED_CAP_CALL)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();
    expect(
      found,
      "#4317 review round 4: only applyPromoCodeChanges' in-progress arm scales a capped promotion's records",
    ).toEqual([...CARRIED_CAP_SITES]);
    const plan = sources.find((file) => repoRelative(file.absolute) === CARRIED_CAP_SITES[0])!;
    expect([...plan.code.matchAll(CARRIED_CAP_CALL)]).toHaveLength(1);
    expect(
      sources.filter((file) => RE_DECIDED_PLAN_RATES.test(file.code)).map((file) => repoRelative(file.absolute)),
      "#4317 review round 4: an in-progress plan hands the promotion engine no nights",
    ).toEqual([]);
  });

  it("keeps every engine-priced door carrying a night-less strand's money", () => {
    const found = strippedSources()
      .filter((file) => [...file.code.matchAll(UNATTACHED_MONEY_CALL)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();
    expect(found).toEqual([...UNATTACHED_MONEY_SITES].sort());
  });

  it("leaves the lenient reader deleted, so a held night cannot fall through to today's rate", () => {
    const found = strippedSources()
      .filter((file) => /\blockedNightPricesForGuest\b/.test(file.code))
      .map((file) => repoRelative(file.absolute));
    expect(found, "INV-MOD-028: no edit door may lock only usable rows").toEqual([]);
  });
});

describe("no edit door parks its money (#4317, INV-MOD-028)", () => {
  it("raises no EDIT_FINANCIAL_REVIEW task from any production path", () => {
    // The state module still DEFINES the raise — tests build the open tasks
    // waves B and C settle with it — but nothing in production calls it.
    const found = strippedSources()
      .filter((file) =>
        [...file.code.matchAll(/(?<!function\s)\braiseEditFinancialReviewTask\s*\(/g)]
          .length > 0,
      )
      .map((file) => repoRelative(file.absolute));
    expect(found, "INV-MOD-028: every edit is priced, none is sent to review").toEqual([]);
  });

  it("returns no review branch from any pricing result", () => {
    const found = strippedSources()
      .filter((file) => file.code.includes("financial_review_required"))
      .map((file) => repoRelative(file.absolute));
    expect(found, "INV-MOD-028: PricingResult is priced-only").toEqual([]);
  });
});
