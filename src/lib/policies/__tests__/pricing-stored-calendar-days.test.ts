import { describe, expect, it, vi } from "vitest";

/**
 * CT-4 (#2870), group F2: the pricing engine reads a booking date as the STORED
 * CALENDAR DAY, with no timezone applied at all.
 *
 * ## The defect this closes, in plain English
 *
 * A lodge night is a calendar day. The database holds it in a `@db.Date` column,
 * which Prisma hands back as a `Date` pinned to UTC midnight — an ENCODING of the
 * day and nothing more (`INV-DATE-010`, `INV-DATE-026`). `normalizeBookingDate`
 * in `../pricing.ts` used to read that value through `APP_TIME_ZONE`, the
 * CONTAINER's zone rather than even the club's persisted one
 * (`INV-CONFIG-002`). For a club behind Greenwich that read comes back one day
 * EARLY: the stored `2026-07-04T00:00:00.000Z` was reported as 3 July.
 *
 * `getStayNights` is built on it, so everything per-night moved with it — the
 * season a night is priced in, the weekday a minimum-stay policy triggers on,
 * and (the reason this was the epic's most serious finding) the night list a
 * policy-exception proposal freezes, capacity-checks and executes.
 *
 * ## Why the zone is MOCKED rather than taken from the machine
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`,
 * and CI sets no `TZ`, so on CI the club zone resolves to New Zealand — which is
 * AHEAD of Greenwich, where a UTC-midnight instant never changes date. A suite
 * that let the environment choose therefore could not tell a corrected
 * implementation from the broken one: it is the same "0 of 460 assertions
 * killed" blindness measured on group C's shared render harness.
 *
 * Pinning `America/Denver` here makes the assertions below discriminating on
 * every host, CI included.
 *
 * ## MEASURED, and by TWO mutants rather than one, because they differ
 *
 * The distinction matters: an earlier version of this docblock quoted one number
 * for the mutant it named, and the two are not the same mutant.
 *
 *  - **Restore only the projection**, keeping both new pre-guards —
 *    `parseDateOnly(formatDateOnlyForTimeZone(date))` in place of the decode:
 *    **13 kills**, being 7 of this file's 10, all 3 of the policy-exception ones
 *    in `freeze-and-approval-share-one-frame.test.ts`, and all 3 in
 *    `src/lib/__tests__/booking-exception-new-booking-guest-frame.test.ts`.
 *  - **Restore the whole old body**, which is the mutant a future author would
 *    actually write and the one the paragraph above describes: **14 kills**. The
 *    extra one is the Invalid-Date test, whose old message called `toISOString()`
 *    on the one value that cannot be formatted and so died as
 *    `RangeError: Invalid time value` before ever reaching it.
 *  - **Remove the instant refusal only**, keeping the corrected decode:
 *    **1 kill**, the "REFUSES an instant" test here and nothing else — which is
 *    the honest shape for a guard on a case no other test exercises.
 *
 * So the Invalid-Date test is a GUARD, not a survivor: it is the single assertion
 * that separates the first two mutants. Mislabelling a guard as a deliberate
 * survivor is the failure mode this epic keeps diagnosing, and a future author
 * told the test proves nothing may weaken or delete it. Only TWO tests here
 * genuinely do not discriminate, and each says so in its own comment: the premise
 * check (which asserts the legacy behaviour on purpose) and the direct season
 * lookup (where one projection applied to both sides of a comparison cancels).
 *
 * Note the asymmetry, because it decides which fixtures can prove anything: only
 * a zone BEHIND Greenwich moves a UTC-midnight day, and it always moves it
 * backwards. A club at or ahead of Greenwich was never exposed, which is why the
 * defect survived so long in a New Zealand deployment.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import { getMinimumStayViolations } from "@/lib/policies/minimum-stay";
import {
  calculateBookingPrice,
  findSeasonForDate,
  getNightlyRate,
  getStayNights,
  priceWholeLodgeFlat,
  type GuestInput,
  type SeasonRateData,
} from "@/lib/policies/pricing";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const MEMBER_TYPE = "type-member";

/**
 * The zone the `@/config/operational` factory above pins, named rather than left
 * to the helper's `APP_TIME_ZONE` default, which #3123 deletes. The premise case
 * asserts the two are still the same zone, so this constant cannot drift out of
 * step with the factory and leave every case below passing for the wrong reason.
 */
const CLUB_ZONE_BEHIND_UTC = "America/Denver";

/** Stored days for the whole file. 4 July 2026 is a Saturday in UTC. */
const CHECK_IN = "2026-07-04";
const CHECK_OUT = "2026-07-07";
const NIGHTS = ["2026-07-04", "2026-07-05", "2026-07-06"];

function season(overrides: Partial<SeasonRateData> = {}): SeasonRateData {
  return {
    seasonId: "winter",
    startDate: day(CHECK_IN),
    endDate: day("2026-09-30"),
    type: "WINTER",
    rates: [
      {
        ageTier: "ADULT",
        membershipTypeId: MEMBER_TYPE,
        pricePerNightCents: 4500,
      },
    ],
    ...overrides,
  };
}

const adult: GuestInput = {
  ageTier: "ADULT",
  isMember: true,
  rateMembershipTypeId: MEMBER_TYPE,
  rateSource: "OWN_TYPE",
};

describe("the pricing engine reads booking dates as stored calendar days (CT-4, #2870)", () => {
  it("PREMISE: the mocked club zone really does move a stored day", () => {
    // Measured, not assumed. If `America/Denver` ever stopped shifting a
    // UTC-midnight day, every assertion below would hold for the wrong reason
    // and this file would silently stop guarding anything — the failure mode
    // this epic keeps diagnosing. The legacy helper below is exactly what
    // `normalizeBookingDate` used to call, and the zone it read is
    // `APP_TIME_ZONE` — so the constant has to keep naming it.
    expect(APP_TIME_ZONE).toBe(CLUB_ZONE_BEHIND_UTC);
    expect(formatDateOnlyForTimeZone(day(CHECK_IN), CLUB_ZONE_BEHIND_UTC)).toBe(
      "2026-07-03",
    );
  });

  it("expands a stay to the stored nights, not to a projection of them", () => {
    expect(getStayNights(day(CHECK_IN), day(CHECK_OUT)).map(formatDateOnly)).toEqual(
      NIGHTS,
    );
  });

  it("states the season-boundary semantics: the stored day decides", () => {
    // MEASURED NOT DISCRIMINATING, and recorded rather than dressed up. A single
    // projection applied to BOTH sides of this comparison cancels: the old body
    // shifted the night and the season edge by the same day, so these three
    // assertions hold under the defect too. They document the rule; the two
    // tests below are what would catch its return.
    const seasons = [season()];

    expect(findSeasonForDate(day(CHECK_IN), seasons)?.seasonId).toBe("winter");
    expect(
      getNightlyRate(day(CHECK_IN), "ADULT", MEMBER_TYPE, seasons)?.priceCents,
    ).toBe(4500);
    expect(findSeasonForDate(day("2026-07-03"), seasons)).toBeNull();
  });

  it("prices a stay's first night in the season that stored day belongs to", () => {
    /*
      THIS is where the season boundary actually broke, and the mechanism is
      worth stating because it is sharper than "one day early".

      The old `normalizeBookingDate` was NOT IDEMPOTENT. Measured under
      `America/Denver`, applying it to the stored `2026-07-04` gave `2026-07-03`,
      applying it again gave `2026-07-02`, and again `2026-07-01`. Along this path
      it ran more than once — `getStayNights` normalised the envelope, then
      `findRateForNight` normalised the resulting night AGAIN through
      `getBookingDateKey` — while a `Season.startDate` read straight off the row
      was normalised only once. So the night key and the season key ended up one
      to two days apart, and the stay's first night fell out of its own season
      rather than merely shifting inside it.

      A member's quote for the first night of a season therefore failed to price
      at all ("No rate found") rather than pricing wrongly, which is why this
      assertion is the discriminating one and the direct lookup above is not.
    */
    const breakdown = calculateBookingPrice(
      day(CHECK_IN),
      day("2026-07-05"),
      [adult],
      [season()],
    );

    expect(breakdown.guests[0].nightDates.map(formatDateOnly)).toEqual([CHECK_IN]);
    expect(breakdown.totalPriceCents).toBe(4500);
  });

  it("triggers a minimum-stay policy on the stored weekday", () => {
    /*
      Saturday only (`getUTCDay() === 6`), which the stored 4 July 2026 is. A
      ONE-night stay is deliberate: a three-night window still contains a
      Saturday after being shifted a day, so a longer stay would pass under the
      defect and prove nothing. On a single stored Saturday the projection reads
      Friday the 3rd, the trigger does not match, and a club behind Greenwich
      silently stopped enforcing its weekend minimum.
    */
    const saturdayPolicy = {
      id: "p1",
      name: "Saturday two-night minimum",
      startDate: day("2026-01-01"),
      endDate: day("2026-12-31"),
      triggerDays: [6],
      minimumNights: 2,
      lodgeId: null,
      version: 1,
      capacityMode: "HOLD" as const,
    };

    const violations = getMinimumStayViolations(
      day(CHECK_IN),
      day("2026-07-05"),
      [saturdayPolicy],
      "lodge_1",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].policyId).toBe("p1");
  });

  it("applies a minimum-stay policy's own date WINDOW on the stored days", () => {
    /*
      The weekday is only half of what the projection moved. `getMinimumStayViolations`
      compares each night against `policy.startDate`/`endDate` — raw `@db.Date`
      values, never normalised — so a shifted night also fell outside its own
      policy window. `validateMinimumStay` pre-filters the same way
      (`policy.startDate <= lastNight && policy.endDate >= firstNight` in
      `src/lib/booking-policies.ts`), on nights from this same helper.

      Both trigger days are Friday AND Saturday here on purpose, so the ONLY thing
      these two assertions can discriminate on is the window. Under the projection
      a one-night stay on the stored Saturday 4 July read as Friday 3 July: a
      policy window opening on the arrival day did not enforce, and one that closed
      the day before arrival did.
    */
    const bothDays = {
      id: "p2",
      name: "Weekend two-night minimum",
      triggerDays: [5, 6],
      minimumNights: 2,
      lodgeId: null,
      version: 1,
      capacityMode: "HOLD" as const,
    };

    // Opens exactly on the arrival day: enforces.
    expect(
      getMinimumStayViolations(
        day(CHECK_IN),
        day("2026-07-05"),
        [{ ...bothDays, startDate: day(CHECK_IN), endDate: day(CHECK_IN) }],
        "lodge_1",
      ),
    ).toHaveLength(1);

    // Closes the day BEFORE arrival: does not.
    expect(
      getMinimumStayViolations(
        day(CHECK_IN),
        day("2026-07-05"),
        [{ ...bothDays, startDate: day("2026-06-01"), endDate: day("2026-07-03") }],
        "lodge_1",
      ),
    ).toHaveLength(0);
  });

  it("prices a guest's explicit night set on the stored days", () => {
    // All three `GuestNightInput` shapes reach `normalizeBookingDate`, and a
    // `BookingGuestNight` row and a `yyyy-MM-dd` key must not disagree.
    const breakdown = calculateBookingPrice(
      day(CHECK_IN),
      day(CHECK_OUT),
      [
        { ...adult, nights: NIGHTS },
        { ...adult, nights: NIGHTS.map(day) },
        { ...adult, nights: NIGHTS.map((night) => ({ stayDate: day(night) })) },
      ],
      [season()],
    );

    for (const guest of breakdown.guests) {
      expect(guest.nightDates.map(formatDateOnly)).toEqual(NIGHTS);
      expect(guest.perNightCents).toEqual([4500, 4500, 4500]);
    }
    expect(breakdown.totalPriceCents).toBe(4500 * 3 * 3);
  });

  it("keys a whole-lodge flat rate on the stored days", () => {
    // `priceWholeLodgeFlat` returns null when any night falls outside a season
    // carrying a flat rate, so a shifted first night turns a priceable stay into
    // an unpriceable one — the officer loses the "price as whole lodge" toggle.
    expect(
      priceWholeLodgeFlat(day(CHECK_IN), day(CHECK_OUT), [
        {
          startDate: day(CHECK_IN),
          endDate: day("2026-09-30"),
          flatWholeLodgeNightCents: 30_000,
        },
      ]),
    ).toBe(90_000);
  });

  it("REFUSES an instant rather than silently flooring it to a UTC day", () => {
    /*
      THE CONTRACT, ENFORCED — and this is the one assertion that keeps the
      docblock on `normalizeBookingDate` true as the tree changes.

      `2026-07-03T12:00:00.000Z` is NZ-local midnight on 4 July, and it is exactly
      what the two retired tests in `src/lib/__tests__/pricing.test.ts` used to
      feed this engine. `calendarDateOfDateOnlyInstant` TRUNCATES a non-midnight
      value to its UTC day rather than complaining — its own kernel docblock says
      "hand it a real `DateTime` and you get that column's UTC day, which is the
      `INV-DATE-019` defect" — so without this guard `getStayNights` would answer
      with nights starting 3 July and nothing anywhere would fail. Note that under
      the projection this lane removed, that same input was accidentally RIGHT for
      an NZ club, so the fix removed a safety net and the guard puts one back.

      Refusing is not the "guessing which kind it was handed" the docblock rules
      out: the function still never decides, it declines.
    */
    const instant = new Date("2026-07-03T12:00:00.000Z");
    const notInstants = "not instants";

    expect(() => getStayNights(instant, day(CHECK_OUT))).toThrow(notInstants);
    // Season edges go through the same helper, so they are guarded too.
    expect(() =>
      findSeasonForDate(day(CHECK_IN), [season({ startDate: instant })]),
    ).toThrow(notInstants);
    // The message names the value and the remedy, because the caller has to fix
    // its own boundary rather than this function.
    expect(() => getStayNights(instant, day(CHECK_OUT))).toThrow(
      "2026-07-03T12:00:00.000Z",
    );

    // And it refuses the KIND, not the value: the stored day is still accepted.
    expect(getStayNights(day(CHECK_IN), day(CHECK_OUT)).map(formatDateOnly)).toEqual(
      NIGHTS,
    );
  });

  it("refuses an Invalid Date rather than throwing while building its message", () => {
    // The old body reached the decoder first and died inside `Intl` with
    // `RangeError: Invalid time value`, so this branch was unreachable — and its
    // own message called `toISOString()` on the very value that cannot be
    // formatted, which would have thrown a second time.
    expect(() => getStayNights(new Date(NaN), day(CHECK_OUT))).toThrow(
      "Invalid booking date: Invalid Date",
    );
  });
});
