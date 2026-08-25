import { describe, expect, it } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  AGE_TIER_DEFAULTS,
  computeAge,
  computeAgeOnCalendarDays,
  computeAgeTierWithSettings,
  getSeasonStartCalendarDate,
  getSeasonStartDate,
} from "@/lib/policies/age-tier";
import {
  __setFinancialYearEndMonthForTesting,
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
} from "@/lib/financial-year";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * `computeAge` and `getSeasonStartDate` answer the same on every host (#3082).
 *
 * ## THE DEFECT, AND THE DIRECTION IT ACTUALLY RAN
 *
 * `computeAge` read a UTC-midnight `@db.Date` date of birth with HOST-local
 * getters (`getFullYear`/`getMonth`/`getDate`), so a host behind Greenwich saw
 * the PREVIOUS day — which makes the member look a day OLDER, not younger,
 * because their birthday appears to have already passed.
 *
 * That direction matters, because #3082's own body had it the other way round
 * ("born 2008-04-01 under America/Denver returns 17 where the member is 18").
 * Measured: it returns 18 under every zone, which is correct. The member the
 * defect really fires on is the one born the day AFTER the boundary, and
 * `cron-age-up.test.ts` already said so in a comment — "under a host WEST of UTC
 * the day-after member would be promoted a year early".
 *
 * Swept over every stored date of birth in a full year against the 1 April 2026
 * season start, on all 418 zones this runtime knows: **161 zones — every zone
 * behind Greenwich — misclassified exactly one day of birthdays, 2 April, and by
 * +1 year.** Never a different day, never a different size. `Pacific/Auckland`,
 * `Etc/UTC` and every zone at or ahead of Greenwich were already correct, which
 * is why this shipped latent rather than live.
 *
 * At a true age of 4, 9 or 17 that +1 crosses an `AGE_TIER_DEFAULTS` boundary,
 * so an ADULT band gets quoted where YOUTH is correct — and `cron-age-up` would
 * hand that member their own login a season early.
 *
 * ## WHY THE HOST PIN IS THE WHOLE TEST
 *
 * The mutation this suite exists to kill is the retired body, and it cannot be
 * killed on this machine's own clock or on a UTC runner: both are at or ahead of
 * Greenwich, where the old reading was right. Every discriminating assertion
 * below therefore runs under `America/Denver`, and the ones that state a
 * host-independence property run under all three zones so a regression to a
 * host-local read fails on the zone rather than on the arithmetic.
 */

/** One zone behind Greenwich, one ahead, and UTC itself. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

/** Behind Greenwich, so UTC midnight is the previous evening locally. */
const BEHIND_GREENWICH = "America/Denver";

function onEveryHostZone(assert: (hostZone: string) => void): void {
  for (const hostZone of HOST_ZONES) {
    withTimeZone(hostZone, () => assert(hostZone));
  }
}

/** A stored `@db.Date` date of birth: the calendar day, at UTC midnight. */
function storedDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

describe("computeAge reads a stored date of birth as the day it names (#3082)", () => {
  it("does not age the day-after-boundary member by a year on a host behind Greenwich", () => {
    // THE DISCRIMINATING ASSERTION. Born 2 April 2008, judged at the 1 April
    // 2026 season start: they turn 18 on 2 April 2026, the day after, so they
    // are 17 for this season and YOUTH.
    //
    // Under `America/Denver` the retired body read 2008-04-02T00:00:00Z as
    // 1 April locally — the same month and day as the season start — decided the
    // birthday had passed, and returned 18. ADULT, a season early, and a
    // different price band.
    withTimeZone(BEHIND_GREENWICH, () => {
      const dob = storedDay("2008-04-02");
      const seasonStart = getSeasonStartDate(2026);

      expect(computeAge(dob, seasonStart)).toBe(17);
      expect(
        computeAgeTierWithSettings(dob, seasonStart, AGE_TIER_DEFAULTS),
      ).toBe("YOUTH");
    });
  });

  it("gives that member the same answer on every host", () => {
    // The property behind the assertion above: 161 of 418 zones used to differ
    // here, and none may now.
    const answers = HOST_ZONES.map((hostZone) =>
      withTimeZone(hostZone, () =>
        computeAge(storedDay("2008-04-02"), getSeasonStartDate(2026)),
      ),
    );

    expect(new Set(answers)).toEqual(new Set([17]));
  });

  it("still admits the member born exactly ON the boundary, everywhere", () => {
    // The case #3082's body named. It was ALREADY right on every host — reading
    // a day early moves the birthday earlier, not later — so a fix that broke it
    // would be the opposite off-by-one, and this is what refuses that.
    onEveryHostZone((hostZone) => {
      const dob = storedDay("2008-04-01");
      const seasonStart = getSeasonStartDate(2026);

      expect(computeAge(dob, seasonStart), hostZone).toBe(18);
      expect(
        computeAgeTierWithSettings(dob, seasonStart, AGE_TIER_DEFAULTS),
        hostZone,
      ).toBe("ADULT");
    });
  });

  it("moves the INFANT and CHILD boundaries too, not only ADULT", () => {
    // The same +1 crosses every configured boundary, so the exposure is not one
    // tier. Both of these were the next tier up under the old reading.
    withTimeZone(BEHIND_GREENWICH, () => {
      const seasonStart = getSeasonStartDate(2026);

      // Turns 5 on 2 April 2026: still 4, still INFANT (0-4) this season.
      expect(
        computeAgeTierWithSettings(
          storedDay("2021-04-02"),
          seasonStart,
          AGE_TIER_DEFAULTS,
        ),
      ).toBe("INFANT");
      // Turns 10 on 2 April 2026: still 9, still CHILD (5-9) this season.
      expect(
        computeAgeTierWithSettings(
          storedDay("2016-04-02"),
          seasonStart,
          AGE_TIER_DEFAULTS,
        ),
      ).toBe("CHILD");
    });
  });

  it("refuses a value carrying a UTC time of day rather than flooring it", () => {
    // The `seasonYearOfStoredDate` refusal, shared. A moment floored to its UTC
    // day is right for a club east of Greenwich and wrong for the rest, which is
    // harder to notice than being wrong everywhere. Unreachable from the
    // database — both columns are `@db.Date` — so it fires for a value some code
    // path built from the clock.
    expect(() =>
      computeAge(new Date("2008-04-02T06:00:00.000Z"), getSeasonStartDate(2026)),
    ).toThrow(/computeAge's dateOfBirth takes a stored calendar day, not a moment/);
    expect(() =>
      computeAge(storedDay("2008-04-02"), new Date("2026-04-01T00:00:00.001Z")),
    ).toThrow(/computeAge's referenceDate takes a stored calendar day/);
    // And it names what the caller should have passed instead.
    //
    // NOT `new Date()`, deliberately. The frozen test clock is
    // `2026-07-01T00:00:00.000Z` — exactly UTC midnight — so "now" passes this
    // guard in every unit test in this repository and would make the assertion
    // vacuous. A real clock-derived reference is spelled out instead.
    expect(() =>
      computeAge(storedDay("2008-04-02"), new Date("2026-04-01T13:00:00.000Z")),
    ).toThrow(/getSeasonStartDate\(seasonYear\)/);
  });

  it("refuses an invalid Date instead of answering NaN", () => {
    // The old body returned NaN, and `computeAgeTierWithSettings` then matched
    // no tier and fell through to its ADULT default — a silent wrong price band
    // from a value nobody could read as a birthday.
    expect(() => computeAge(new Date("not a date"), getSeasonStartDate(2026))).toThrow(
      /valid Date holding a @db.Date/,
    );
  });
});

describe("getSeasonStartDate is the season's calendar day, encoded in UTC", () => {
  it("is UTC midnight on the first of the season-start month, on every host", () => {
    // It used to be `new Date(seasonYear, startMonth - 1, 1)` — a different
    // instant in every zone. `2026-03-31T11:00:00.000Z` under the club's own
    // `Pacific/Auckland` pin, which is the value that had to change for
    // `computeAge` to be able to read both its arguments the same way.
    onEveryHostZone((hostZone) => {
      expect(getSeasonStartDate(2026).toISOString(), hostZone).toBe(
        "2026-04-01T00:00:00.000Z",
      );
      expect(getSeasonStartCalendarDate(2026), hostZone).toBe("2026-04-01");
    });
  });

  it("follows the club's configured year-end month", () => {
    try {
      __setFinancialYearEndMonthForTesting(6);
      onEveryHostZone((hostZone) => {
        expect(getSeasonStartCalendarDate(2026), hostZone).toBe("2026-07-01");
        expect(getSeasonStartDate(2026).toISOString(), hostZone).toBe(
          "2026-07-01T00:00:00.000Z",
        );
      });

      __setFinancialYearEndMonthForTesting(12);
      onEveryHostZone((hostZone) => {
        expect(getSeasonStartCalendarDate(2026), hostZone).toBe("2026-01-01");
      });
    } finally {
      __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    }
  });
});

describe("computeAgeOnCalendarDays keeps the arithmetic it always had", () => {
  it("counts completed years, and only completed ones", () => {
    const ref = requireCalendarDate("2026-04-01");

    expect(computeAgeOnCalendarDays(requireCalendarDate("2008-03-31"), ref)).toBe(18);
    expect(computeAgeOnCalendarDays(requireCalendarDate("2008-04-01"), ref)).toBe(18);
    expect(computeAgeOnCalendarDays(requireCalendarDate("2008-04-02"), ref)).toBe(17);
    expect(computeAgeOnCalendarDays(requireCalendarDate("2008-05-01"), ref)).toBe(17);
  });

  it("counts a 29 February birthday on 1 March, as it always did", () => {
    // DELIBERATELY DIFFERENT from `member-age.ts`, which clamps the anniversary
    // to 28 February for an identity check. This one decides a price band and
    // its convention is unchanged by #3082: `day` is compared as written, so
    // 28 < 29 and the birthday has not arrived. Two conventions, two purposes —
    // aligning them would move a real member's tier for one day a year and needs
    // a decision, not a tidy-up.
    const dob = requireCalendarDate("2008-02-29");

    expect(computeAgeOnCalendarDays(dob, requireCalendarDate("2026-02-28"))).toBe(17);
    expect(computeAgeOnCalendarDays(dob, requireCalendarDate("2026-03-01"))).toBe(18);
  });
});
