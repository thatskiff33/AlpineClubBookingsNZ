import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toSeasonRateData } from "@/lib/policies/booking-route-decisions";

/**
 * Census: every loader that feeds an in-progress edit must select the column
 * that says what a night was SOLD for (#2744), and every builder of the plan must
 * hand it the club's group-discount config (#2756).
 *
 * `buildInProgressGuestRangePlan` credits a night given back at the price
 * recorded on its `BookingGuestNight` row, and falls back to the guest's own
 * stored per-night average for a night whose price it cannot see (#2771; a night
 * the edit BUYS still prices at the current season rate, INV-MOD-005). It cannot
 * tell "this night has no stored price" from "this query did not ask for it":
 * both arrive as a row with no `priceCents`, and both take the fallback.
 *
 * So the whole money fix rests on two Prisma selects saying
 * `nights: { select: { stayDate: true, priceCents: true } }`, and the failure
 * mode if one stops is the worst kind. Nothing throws, nothing fails to
 * type-check — `priceCents` is optional on the plan's night type so that a
 * caller holding a bare `Date` still compiles — and no unit test notices,
 * because the plan-level suites build guests by hand and
 * `calculate-modified-pricing-capacity.test.ts` mocks the database. The only
 * symptom is a member being refunded a flat average of their own booking for
 * every night, whatever each one actually cost — which reconciles, sums and
 * looks entirely healthy.
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
/**
 * The same text with `//` and block comments blanked out.
 *
 * Both checks below read source text for the presence of a field, and prose
 * mentioning the field is not the field. Newlines are preserved so a stripped
 * comment cannot join two lines into something that matches.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

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
        const argumentList = withoutComments(
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
    const found = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          [
            ...withoutComments(fs.readFileSync(absolute, "utf8")).matchAll(
              SEASON_RATE_MAPPING,
            ),
          ].length > 0,
      )
      .map(repoRelative)
      .sort();

    // A second mapper is how `type` went missing on five edit paths at once. If a
    // new loader needs season rates, call `toSeasonRateData` rather than mapping
    // the rows again — the type system cannot object, because the field is
    // optional.
    expect(found).toEqual([SEASON_RATE_MAPPER_FILE]);
  });
});
