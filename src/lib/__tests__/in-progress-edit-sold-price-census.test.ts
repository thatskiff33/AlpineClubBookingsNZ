import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toSeasonRateData } from "@/lib/policies/booking-route-decisions";

import { stripComments } from "./support/strip-comments";

/**
 * Census: every loader that feeds an in-progress edit must select the column
 * that says what a night was SOLD for (#2744), and every builder of the plan must
 * hand it the club's group-discount config (#2756).
 *
 * THE FILENAME UNDERSELLS IT, AND IS KEPT ANYWAY. Since #3166 four of the five
 * lenient-reader sites below are PRE-check-in paths, and the last block in this
 * file is the pre-check-in gate census. A rename would read better and would
 * disarm every path-hardcoded scanner that names this file — including three
 * ways of doing so silently — for no measured benefit. The scope is what the
 * describe blocks say, not what the name says.
 *
 * `buildInProgressGuestRangePlan` credits a night given back at the price
 * recorded on its `BookingGuestNight` row. Since #3031 it does not fall back to
 * anything: a night whose stored price it cannot see makes the whole edit
 * `financial_review_required`, because inventing the amount is what epic #2797
 * exists to stop. What has NOT changed is that the plan cannot tell "this night
 * has no stored price" from "this query did not ask for it" — both arrive as a
 * row with no `priceCents`.
 *
 * So the whole money path still rests on two Prisma selects saying
 * `nights: { select: { stayDate: true, priceCents: true } }`, and the failure
 * mode if one stops is still silent in the type system: `priceCents` is optional
 * on the plan's night type so that a caller holding a bare `Date` compiles, and
 * the plan-level suites build guests by hand while
 * `calculate-modified-pricing-capacity.test.ts` mocks the database.
 *
 * #3031 changed what that failure LOOKS like, and the new one is much louder: a
 * trimmed select no longer refunds a member at today's price list, it makes
 * every in-progress edit on every booking refuse as unpriceable. Louder is not
 * the same as caught, and an outage is not obviously better than a quiet
 * over-refund, so this census still earns its place.
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

/**
 * The balanced `( … )` starting at `openIndex` (the index OF the `(`).
 *
 * Brace-matched by hand rather than by regex: the argument is a nested object
 * literal several levels deep, so `[^)]*` stops at the first inner `)` and would
 * report a caller that passes the config as one that does not. Strings and
 * comments are not tracked, because neither appears with an unbalanced bracket in
 * these two call sites and a false FAILURE here is cheap to diagnose while a
 * false pass is the thing being guarded against.
 */
function balancedArgumentList(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
  }
  throw new Error(`unbalanced argument list at index ${openIndex}`);
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
    nightsSelects: 1,
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
      const builderCalls = [...source.matchAll(PLAN_BUILDER_CALL)];

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
          balancedArgumentList(source, openIndex),
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
    expect(found).toEqual([SEASON_RATE_MAPPER_FILE]);
  });
});


/**
 * `lockedNightPricesForGuest` — the LENIENT reader, and the door every edit path
 * that is not the in-progress planner goes through (#3031, E6).
 *
 * It turns whatever prices a guest's rows carry into `lockedNightPrices` and
 * says nothing at all about the rows it could not use: a night with no usable
 * price simply yields no lock, and an unlocked night prices at the CURRENT
 * season rate. That is the right answer for a night the edit is genuinely
 * BUYING and the wrong answer for a night it is giving BACK, and the function
 * cannot tell them apart, because it is handed no idea what the edit is doing.
 *
 * It is deliberately NOT made strict. A strict version would refuse the guest-add
 * and date-change paths, where an unlocked night is a night being bought and
 * pricing it at today's rate is correct policy. What #3031 adds instead is the
 * strict twin — `storedSoldPriceEvidenceForGuest` — which returns a verdict
 * rather than a best effort, and which the guest-removal path asks BEFORE it
 * prices anything, because a removal gives every one of the departing guest's
 * nights back.
 *
 * This census is what stops a SEVENTH caller appearing without that choice being
 * made. A new edit path reaching for the lenient reader because it is the
 * obvious one is precisely how "never guess historical money" comes undone, and
 * nothing in the type system objects: both functions compile at every call site.
 */
const LENIENT_LOCK_CALL_SITES = [
  {
    file: "src/app/api/bookings/[id]/guests/route.ts",
    calls: 1,
    what: "adding a guest: the existing party keep their booked prices while the new guest's nights are bought at current rates. An unlocked night here is a night nobody is giving back — but it still reached the booking's recomputed TOTAL at today's rate, which #3166 closed by asking preCheckInEditEvidence first and parking the whole add when a strand cannot be read",
  },
  {
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
    calls: 1,
    what: "the QUOTE path's ORDINARY (not in-progress) pricing pass. The in-progress branch of the same route does not use this reader at all — it goes through the planner, which is strict. Since #3166 the ordinary branch is judged by preCheckInEditEvidence AFTER this pass, against the night sets it produced, so the preview parks whenever the save would",
  },
  {
    file: "src/lib/booking-date-modification-service.ts",
    calls: 1,
    what: "a date change: the locks are keyed by NORMALISED stay date, so a night the guest keeps across the move matches its lock however far the range moved and keeps its booked price - only genuinely new nights reach the season table. The old side of the credit is `Booking.finalPriceCents` as stored, so nothing here reconstructs a historical amount. It used NOT to test that the stored rows can account for that total, so a strand with no usable per-night price had its nights valued at today's rate AND written back as integers; #3166 added preCheckInEditEvidence after the pricing pass, and an unreadable strand now parks with NULL on every night this booking cannot account for",
  },
  {
    file: "src/lib/booking-guest-removal-service.ts",
    calls: 1,
    what: "the REMOVAL path, which is the one that gives nights back — and which asks storedSoldPriceEvidenceForGuest first and refuses the removal outright unless every strand reconciles. By the time this reader runs, every night it is handed is known to be locked",
  },
  {
    file: "src/lib/booking-modify-plan.ts",
    calls: 2,
    what: "prepareGuestPlan (the apply path's ordinary pricing pass) and the proposed-remaining-guest pass. The declaration itself is excluded by the pattern's lookbehind. Since #3166 the amounts this reader produces for an unreadable strand are computed and then DISCARDED: calculateModifiedPricing judges every existing strand against the night sets the pass produced and parks the edit, writing the stored price where there is one and NULL where there is not",
  },
] as const;

/**
 * {@link LENIENT_LOCK_CALL} without `g`, for `String.search` — a global flag
 * makes a regex stateful, and a shared stateful one is a test that passes or
 * fails depending on what ran before it.
 */
const LENIENT_LOCK_CALL_ONCE =
  /(?<!function\s)\blockedNightPricesForGuest\s*\(/;

/** A CALL, not the declaration or a re-export. */
const LENIENT_LOCK_CALL =
  /(?<!function\s)\blockedNightPricesForGuest\s*\(/g;

describe("lenient locked-night reader census (#3031, E6)", () => {
  it("declares every production caller of the lenient reader", () => {
    const found = strippedSources()
      .filter((file) => [...file.code.matchAll(LENIENT_LOCK_CALL)].length > 0)
      .map((file) => repoRelative(file.absolute))
      .sort();

    // A new caller must be classified here: does this path VALUE a night it is
    // giving back? If yes it needs `storedSoldPriceEvidenceForGuest`, not this.
    expect(found).toEqual(
      LENIENT_LOCK_CALL_SITES.map((site) => site.file as string).sort(),
    );
  });

  it("counts the calls in each declared file, so a second one cannot hide", () => {
    for (const site of LENIENT_LOCK_CALL_SITES) {
      const source = stripComments(
        fs.readFileSync(path.resolve(process.cwd(), site.file), "utf8"),
      );
      expect([...source.matchAll(LENIENT_LOCK_CALL)].length, site.file).toBe(
        site.calls,
      );
    }
  });

  it("keeps the removal path asking the STRICT twin, and fencing the reprice on its answer", () => {
    // The one lenient call site that values nights being GIVEN BACK. It is safe
    // only because the strict gate decides first; delete the gate and the removal
    // silently reprices a remaining guest's stay at today's rate again, reporting
    // the movement as the departing guest's credit (#3031, E10).
    //
    // WHAT THIS ASSERTED BEFORE #3032, AND WHY IT MOVED. It used to require a
    // `throw new BookingEditFinancialReviewRequiredError(` ahead of the lenient
    // reader: the gate's answer was a REFUSAL, so "refuses before repricing" was
    // the whole safety property. #3032 replaced the refusal with a park - the
    // guest comes off and the amount is held as an OPEN review task - so there is
    // no throw left to find, and asserting one would pin behaviour that was
    // deliberately removed. The property it was protecting is unchanged, and is
    // now asserted directly: THE REPRICE IS FENCED ON THE GATE'S ANSWER.
    //
    // ASSERTED AS CALLS AND AS AN ORDER, not as the presence of the words. A bare
    // `toContain("storedSoldPriceEvidenceForGuest")` is satisfied by an IMPORT of
    // the symbol, so it would still pass with the gate deleted and the import left
    // behind - which is the likeliest way this actually regresses, because nothing
    // else complains about an unused import until knip runs.
    const source = stripComments(
      fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/booking-guest-removal-service.ts"),
        "utf8",
      ),
    );

    const strictCall = source.search(
      /(?<!function\s)\bstoredSoldPriceEvidenceForGuest\s*\(/,
    );
    const lenientCall = source.search(LENIENT_LOCK_CALL_ONCE);
    // #3032: the verdict is derived from `strandEvidence` - the strict twin's
    // per-strand answers - rather than from the length of the occurrence list it
    // used to be counted off. The two came apart when a parked removal started
    // recording the DEPARTING strand even where that strand's own rows are exact:
    // the occurrence list is no longer "the unreadable ones", so counting it is
    // no longer the same question as "is anything unreadable". Matched on the
    // derivation, so a verdict computed from something other than the gate's
    // answers fails here.
    const verdict = source.search(
      /const parkedFinancialReview =\s*strandEvidence\.some\(/,
    );
    const fence = source.search(/if \(!parkedFinancialReview\) \{/);
    const repriceCall = /await priceBookingGuestsWithMembershipTypePolicy\s*\(/;
    const reprice = source.search(repriceCall);
    const raise = source.search(
      /await raiseParkedEditFinancialReviewTasks\s*\(/,
    );

    expect(
      strictCall,
      "the strict twin must be CALLED, not merely imported",
    ).toBeGreaterThan(-1);
    expect(
      verdict,
      "the gate's answer must be kept, not discarded",
    ).toBeGreaterThan(-1);
    expect(
      raise,
      "an unusable strand must be PARKED, not merely noted",
    ).toBeGreaterThan(-1);
    expect(lenientCall).toBeGreaterThan(-1);
    expect(reprice).toBeGreaterThan(-1);
    // The gate decides before the lenient reader is handed anything.
    expect(strictCall).toBeLessThan(lenientCall);
    expect(strictCall).toBeLessThan(verdict);
    // And the reprice - the pass that would revalue a remaining guest's nights
    // at today's rate - sits INSIDE the fence the gate's answer opens. This is
    // the assertion the refusal check used to stand in for.
    expect(
      fence,
      "the reprice must be fenced on the gate's answer",
    ).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(fence);
    expect(fence).toBeLessThan(reprice);
    // Exactly one reprice, so a second unfenced call cannot hide behind it.
    expect([...source.matchAll(new RegExp(repriceCall, "g"))]).toHaveLength(1);
  });
});

/**
 * #3166: THE PRE-CHECK-IN GATE, ASSERTED THE WAY THE REMOVAL PATH'S IS.
 *
 * The `what` strings in the census above widened when #3166 landed — "closed by
 * asking preCheckInEditEvidence first", "an unreadable strand now parks with
 * NULL on every night", "the preview parks whenever the save would" — and
 * NOTHING in that file measured any of it. Delete the gate from
 * `booking-date-modification-service.ts` and the census stayed green while its
 * own prose said that path parks. Prose in a census is documentation of a
 * measurement, not the measurement.
 *
 * So this mirrors what the removal path already does, on the three sites #3166
 * added plus the preview that has to agree with them, and for the same stated
 * reason: a bare `toContain("preCheckInEditEvidence")` is satisfied by an IMPORT
 * of the symbol, which is the likeliest way this regresses — nothing complains
 * about an unused import until knip runs. Every marker below is therefore a CALL
 * or an assignment, and the ORDER between them is asserted, because "the gate
 * runs somewhere in this file" is not the property. The property is that it runs
 * against the night sets the pricing pass produced and that its answer is what
 * fences the write.
 */
const PRE_CHECK_IN_GATE_SITES = [
  {
    file: "src/lib/booking-modify-plan.ts",
    what: "the SAVE. calculateModifiedPricing judges every existing strand after the pricing pass and returns the parked exit instead of a priced plan.",
    /** In the order they must appear. */
    markers: [
      {
        // The gate is the OUTER call and the assembly is its argument, so the
        // gate reads first: this is a nesting, and the order asserts that.
        label: "the gate is CALLED, not merely imported",
        pattern: /preCheckInEditEvidence\s*\(\s*\{/,
      },
      {
        label: "the strands are assembled from the pricing pass's own night sets",
        pattern: /preCheckInEditStrands\s*\(/,
      },
      {
        label: "an unreadable strand takes the parked exit",
        pattern: /kind: "financial_review_required"/,
      },
      {
        label: "the parked rows carry PRESERVED stored prices, never repriced ones",
        pattern: /preservedNightPrices\s*\(/,
      },
    ],
  },
  {
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
    what: "the PREVIEW, which must park whenever the save would or it quotes money the save will not move.",
    markers: [
      {
        // The gate is the OUTER call and the assembly is its argument, so the
        // gate reads first: this is a nesting, and the order asserts that.
        label: "the gate is CALLED, not merely imported",
        pattern: /preCheckInEditEvidence\s*\(\s*\{/,
      },
      {
        label: "the strands are assembled from the pricing pass's own night sets",
        pattern: /preCheckInEditStrands\s*\(/,
      },
      {
        label: "the preview answers with the parked quote",
        pattern: /parkedQuoteResponse\s*\(/,
      },
    ],
  },
  {
    file: "src/lib/booking-date-modification-service.ts",
    what: "the DATE CHANGE, which read night prices through the lenient reader and wrote a blank back as an integer.",
    markers: [
      {
        label: "the gate is CALLED, not merely imported",
        pattern: /preCheckInEditEvidence\s*\(\s*\{/,
      },
      {
        label: "its answer is kept, not discarded",
        pattern: /const parked =\s*dateEditEvidence\.occurrences\.length > 0/,
      },
      {
        label: "the night write uses PRESERVED stored prices when it parks",
        pattern: /preservedNightPrices\s*\(/,
      },
      {
        label: "an unusable strand is PARKED, not merely noted",
        pattern: /await raiseParkedEditFinancialReviewTasks\s*\(/,
      },
    ],
  },
  {
    file: "src/lib/booking-batch-modification-service.ts",
    what: "the BATCH SAVE — the fourth raise door, and the only one that does not ask the gate itself. It inherits the verdict from calculateModifiedPricing, so what has to be measured here is that it KEEPS that verdict, writes the parked rows rather than the priced ones, and raises.",
    markers: [
      {
        // Not `preCheckInEditEvidence` — this door never calls it. The gate it
        // inherits is the one inside `calculateModifiedPricing`, so the marker
        // is that call, and everything after it is what this file does with the
        // answer.
        label: "the gate is inherited from calculateModifiedPricing, not re-derived here",
        pattern: /await calculateModifiedPricing\s*\(/,
      },
      {
        label: "its answer is kept, not discarded",
        pattern: /const parked =\s*pricingResult\.kind === "financial_review_required"/,
      },
      {
        label: "the rows written are the PARKED ones, never the priced pass's",
        pattern: /pricingResult\.parkedGuestRows/,
      },
      {
        label: "an unusable strand is PARKED, not merely noted",
        pattern: /await raiseParkedEditFinancialReviewTasks\s*\(/,
      },
    ],
  },
  {
    file: "src/app/api/bookings/[id]/guests/route.ts",
    what: "the GUEST ADD, which recomputed the booking's total from a full-party pass in which a blank night priced at today's rate.",
    markers: [
      {
        label: "the gate is CALLED, not merely imported",
        pattern: /preCheckInEditEvidence\s*\(\s*\{/,
      },
      {
        label: "its answer is kept, not discarded",
        pattern: /const parked = addEvidence\.occurrences\.length > 0/,
      },
      {
        label: "the booking's total write-back is FENCED on that answer",
        pattern: /const newTotalPriceCents = parked/,
      },
      {
        label: "an unusable strand is PARKED, not merely noted",
        pattern: /await raiseParkedEditFinancialReviewTasks\s*\(/,
      },
    ],
  },
] as const;

describe("pre-check-in exact-evidence gate census (#3166)", () => {
  it.each(PRE_CHECK_IN_GATE_SITES.map((site) => [site.file, site] as const))(
    "%s keeps the gate, its answer, and the order between them",
    (_file, site) => {
      const source = stripComments(
        fs.readFileSync(path.resolve(process.cwd(), site.file), "utf8"),
      );
      // Each marker is looked for in what is LEFT after the one before it, so
      // "must come after" means an occurrence genuinely follows — rather than
      // the first match in the file, which for these files is the in-progress
      // branch's own parked exit several thousand characters earlier.
      //
      // The cursor advances past the END of the match it just made, never one
      // character into it. Advancing by 1 would let a marker satisfy "after the
      // previous one" by matching the SAME text again from its second
      // character, which is only harmless while every pattern here happens to
      // be distinct — and that is a property of today's markers rather than of
      // the walk. `match` is used instead of `search` for exactly that: the
      // length of what matched is the thing the walk needs and `search` cannot
      // report it.
      let previous = 0;
      let previousLabel = "";
      for (const marker of site.markers) {
        const found = source.slice(previous).match(marker.pattern);
        expect(
          found?.index ?? -1,
          previousLabel === ""
            ? `${site.file}: ${marker.label} — ${site.what}`
            : `${site.file}: "${marker.label}" must appear, and after "${previousLabel}" — ${site.what}`,
        ).toBeGreaterThan(-1);
        previous += (found?.index ?? 0) + (found?.[0].length ?? 0);
        previousLabel = marker.label;
      }
    },
  );

  it("judges the SAVE and the PREVIEW against the same assembly, so they cannot park differently", () => {
    // The one property no per-file assertion can state: both surfaces feed
    // `preCheckInEditStrands` the pricing pass's own `priceBreakdown.guests`,
    // which is the night set the save will actually write. A second derivation
    // at either of them is how quote and apply come to disagree about one
    // member's edit — the parity INV-MOD-028 exists to make impossible.
    for (const file of [
      "src/lib/booking-modify-plan.ts",
      "src/app/api/bookings/[id]/modify-quote/route.ts",
    ]) {
      const source = stripComments(
        fs.readFileSync(path.resolve(process.cwd(), file), "utf8"),
      );
      expect(source, file).toMatch(/pricedGuests: priceBreakdown\.guests/);
    }
  });
});
