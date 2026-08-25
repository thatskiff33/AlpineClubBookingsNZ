import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  dateOnlyInstantOf,
  requireCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import {
  AGE_TIER_DEFAULTS,
  computeAgeTierWithSettings,
  getSeasonStartCalendarDate,
  getSeasonStartDate,
} from "@/lib/policies/age-tier";
import { dateOfBirthPrefilterBoundForMinAge } from "@/lib/date-of-birth-prefilter";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * The age-up candidate prefilter's date-of-birth bound (#2859, #2872, #3082).
 *
 * THREE SHIPPED OFF-BY-ONES ARE PINNED HERE, and the first two pull in opposite
 * directions, which is why the bound needs a suite of its own rather than only
 * the one assertion `cron-age-up.test.ts` makes through the query:
 *
 * - #2859 — a bound at the cutoff INSTANT dropped the member born on exactly
 *   the season-start anniversary, because a local-midnight cutoff sits hours
 *   after a UTC-midnight date of birth. The fix widens to the end of the cutoff
 *   calendar day.
 * - #2872 — that widened bound still had to be a CALENDAR DAY, because
 *   `Member.dateOfBirth` is `@db.Date` and the adapter narrows a bound `Date`
 *   to its UTC day. A local-midnight instant east of UTC narrows to the day
 *   BEFORE, which reopens #2859.
 * - #3082 — the ARGUMENT is now a calendar day too. It used to be a host-local
 *   midnight `Date` whose parts were read back with host-local getters, which
 *   was correct only because `getSeasonStartDate` constructed it with the
 *   matching local setters. That round trip really was total (swept: 418 zones,
 *   2015-2036, all twelve possible season-start months, zero failures) — and it
 *   still had to go, because it made this bound's correctness a property of its
 *   CALLER's encoding, and the caller had to move when `computeAge` did.
 *
 * EVERY ASSERTION RUNS UNDER THREE HOST ZONES, one behind UTC and one ahead. On
 * the old signature that was the only way to state the claim at all. It is kept
 * deliberately now that the input is text: the property is that no host can move
 * this answer, and a suite that stopped checking it could not tell a regression
 * back to a `Date` argument from the fix. What changed is that it is no longer
 * the whole argument — the discriminating assertion for the host-local READ now
 * lives in `age-tier-club-calendar.test.ts`, on `computeAge`, which is where the
 * defect actually was.
 */

/** One zone behind UTC, one ahead, and UTC itself. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

/** 1 April 2026 — the default season start, as a calendar day. */
const SEASON_START = requireCalendarDate("2026-04-01");

function onEveryHostZone(assert: (hostZone: string) => void): void {
  for (const hostZone of HOST_ZONES) {
    withTimeZone(hostZone, () => assert(hostZone));
  }
}

describe("the age-tier date-of-birth prefilter bound", () => {
  it("is the UTC-midnight day AFTER the cutoff day, on every host zone", () => {
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(SEASON_START, 18);

      expect(bound.toISOString(), hostZone).toBe("2008-04-02T00:00:00.000Z");
    });
  });

  it("admits the member born on exactly the season-start anniversary (#2859)", () => {
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(SEASON_START, 18);

      // A stored date of birth is UTC midnight (INV-DATE-024). This member turns
      // 18 on season start and must be proposed; the pre-#2859 bound excluded
      // them, one season late for their own age-up.
      const bornOnTheAnniversary = new Date("2008-04-01T00:00:00.000Z");
      expect(bornOnTheAnniversary < bound, hostZone).toBe(true);
    });
  });

  it("excludes the member born the day after, so it is not merely wide", () => {
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(SEASON_START, 18);
      const bornTheDayAfter = new Date("2008-04-02T00:00:00.000Z");

      expect(bornTheDayAfter < bound, hostZone).toBe(false);
    });
  });

  it("is a pure UTC-midnight encoding, which is the only shape @db.Date keeps", () => {
    // `@prisma/adapter-pg` narrows a bound `Date` for a `@db.Date` column to its
    // UTC calendar date and discards the time. Any non-zero UTC time component
    // here would mean the value carries information the column silently drops.
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(SEASON_START, 18);

      expect(
        [
          bound.getUTCHours(),
          bound.getUTCMinutes(),
          bound.getUTCSeconds(),
          bound.getUTCMilliseconds(),
        ],
        hostZone,
      ).toEqual([0, 0, 0, 0]);
    });
  });

  it("names the same day whatever the container's zone is (#2872, #3082)", () => {
    // The property, stated directly rather than inferred from the three
    // per-zone assertions above: one season start, three containers, one answer.
    const bounds = HOST_ZONES.map((hostZone) =>
      withTimeZone(hostZone, () =>
        dateOfBirthPrefilterBoundForMinAge(SEASON_START, 18).toISOString(),
      ),
    );

    expect(new Set(bounds).size).toBe(1);
  });

  it("admits nobody for a minimum age nobody can have reached", () => {
    // `minAge` is validated as `z.number().int().min(0)` with NO ceiling, so an
    // ADULT tier at `minAge >= seasonYear` is absurd but permitted. Stepping the
    // cutoff back past year 1 is a `RangeError` in the kernel's calendar
    // arithmetic, and it would abort the whole nightly age-up run — which also
    // sends email and syncs contact groups for every other member. Nobody HAS
    // reached that age, so the empty candidate set is the correct answer and not a
    // fudge.
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(SEASON_START, 2026);

      expect(bound.toISOString(), hostZone).toBe("0001-01-01T00:00:00.000Z");
      // No stored date of birth can precede it, so the query proposes nobody.
      expect(
        dateOnlyInstantOf(requireCalendarDate("0001-01-01")) < bound,
        hostZone,
      ).toBe(false);
      // And the first year that is NOT absurd still steps normally.
      expect(
        dateOfBirthPrefilterBoundForMinAge(SEASON_START, 2025).toISOString(),
        hostZone,
      ).toBe("0001-04-02T00:00:00.000Z");
    });
  });

  it("follows the configured minimum age rather than assuming 18", () => {
    onEveryHostZone((hostZone) => {
      expect(
        dateOfBirthPrefilterBoundForMinAge(SEASON_START, 21).toISOString(),
        hostZone,
      ).toBe("2005-04-02T00:00:00.000Z");
      expect(
        dateOfBirthPrefilterBoundForMinAge(SEASON_START, 0).toISOString(),
        hostZone,
      ).toBe("2026-04-02T00:00:00.000Z");
    });
  });

  it("composes with getSeasonStartCalendarDate, which is the pair it belongs to", () => {
    // #3082: this used to be the round-trip test — "the host-local getters
    // inside the derivation are only safe because the value they read was
    // CONSTRUCTED with the matching local setters". There is no round trip left
    // to check, so what it checks now is that the two really are one pair: the
    // bound is derived from the same season-start day the age-tier authority
    // judges the candidate against, with nothing in between a host could move.
    onEveryHostZone((hostZone) => {
      const seasonStart = getSeasonStartCalendarDate(2026);
      const bound = dateOfBirthPrefilterBoundForMinAge(seasonStart, 18);

      expect(seasonStart, hostZone).toBe("2026-04-01");
      expect(bound.toISOString(), hostZone).toBe("2008-04-02T00:00:00.000Z");
    });
  });

  it("rolls a month or year boundary rather than emitting an impossible day", () => {
    // Reachable only if a club's season ever starts on the last day of a month,
    // but the encoding must be total: the day after 31 December is 1 January of
    // the next year, not 32 December.
    onEveryHostZone((hostZone) => {
      expect(
        dateOfBirthPrefilterBoundForMinAge(
          requireCalendarDate("2025-12-31"),
          1,
        ).toISOString(),
        hostZone,
      ).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  it("admits exactly the dates of birth the AUTHORITY would promote", () => {
    // THE UNTESTED RELATION, closed. Every other assertion in this file pins the
    // bound's own value; none of them says the bound agrees with the function that
    // actually decides who is promoted. `cron-age-up.test.ts` cannot say it either
    // — it mocks `prisma.member.findMany`, so the bound is never applied to a
    // candidate anywhere in the suite, and a future convention change could
    // silently start dropping the member born on the anniversary (#2859, twice
    // shipped) with every existing assertion still green.
    //
    // The property, stated over the real authority rather than a reimplementation
    // of it: for every date of birth in a window straddling the boundary,
    // `dateOfBirth < bound` if and only if `computeAgeTierWithSettings` answers
    // ADULT. `AGE_TIER_DEFAULTS` makes ADULT the unbounded top tier at 18, which
    // is what `validateAgeTierPartition` guarantees for every valid partition, so
    // "answers ADULT" is exactly "age >= minAge".
    const minAge = 18;
    onEveryHostZone((hostZone) => {
      const seasonStartDay = getSeasonStartCalendarDate(2026);
      const seasonStart = getSeasonStartDate(2026);
      const bound = dateOfBirthPrefilterBoundForMinAge(seasonStartDay, minAge);

      let admitted = 0;
      let promoted = 0;
      for (let offset = -400; offset <= 400; offset += 1) {
        const day: CalendarDate = addCalendarDays(
          requireCalendarDate("2008-04-01"),
          offset,
        );
        const dateOfBirth = dateOnlyInstantOf(day);
        const isAdmitted = dateOfBirth < bound;
        const wouldPromote =
          computeAgeTierWithSettings(
            dateOfBirth,
            seasonStart,
            AGE_TIER_DEFAULTS,
          ) === "ADULT";

        expect(isAdmitted, `${hostZone} ${day}`).toBe(wouldPromote);
        if (isAdmitted) admitted += 1;
        if (wouldPromote) promoted += 1;
      }

      // NOT A VACUOUS AGREEMENT: both sides really do change inside the window,
      // so an implementation that admitted everybody or nobody would fail here
      // rather than agree with itself.
      expect(admitted, hostZone).toBe(401);
      expect(promoted, hostZone).toBe(401);
    });
  });

  it("clamps a 29 February season start rather than rolling into March", () => {
    // Unreachable from `getSeasonStartCalendarDate`, which always names day 1 —
    // but the year step must be total, and the two wrong answers are opposite:
    // the retired `Date.setFullYear` spelling rolled 29 February FORWARD to
    // 1 March, and `calendarDateFromParts(year - 1, 2, 29)` would have thrown.
    // Clamping to 28 February is `addMonthsDateOnly`'s and `member-age.ts`'s
    // convention, so the bound is one day later: 1 March.
    onEveryHostZone((hostZone) => {
      expect(
        dateOfBirthPrefilterBoundForMinAge(
          requireCalendarDate("2024-02-29"),
          1,
        ).toISOString(),
        hostZone,
      ).toBe("2023-03-01T00:00:00.000Z");
    });
  });
});
