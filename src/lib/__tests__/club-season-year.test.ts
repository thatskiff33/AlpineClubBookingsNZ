/**
 * The club's season year, and the two temporal kinds it is derived from
 * (CT-4 group F1, #2870; epic #2988).
 *
 * ## WHY THIS SUITE IS DISCRIMINATING WITHOUT TOUCHING THE ENVIRONMENT
 *
 * Every other Club Time suite has had to fight the shared harness: it sets
 * `CLUB_TIME_TEST_ZONE` equal to `APP_TIME_ZONE`'s fallback, so a suite on the
 * default wrapper cannot tell the persisted zone from the environment however much
 * it asserts (#2870 comment 7 measured 46 of 49 components blind). This suite has
 * no such problem, and the reason is structural rather than clever: the functions
 * under test TAKE THE ZONE AS AN ARGUMENT. Two zones, one clock, two different
 * answers - nothing is read from `process.env`, `APP_TIME_ZONE` or the host, so
 * there is nothing for an environment to make agree by accident.
 *
 * ## THE TWO MUTANTS THIS SUITE EXISTS TO KILL
 *
 * 1. **Ignoring the zone.** The retired `getSeasonYearForYearEndMonth(date, m)`
 *    read `date.getMonth()`/`date.getFullYear()` - the HOST's components - so the
 *    club's zone had no say at all. The `zone authority` block below fails the
 *    moment an implementation stops consulting it.
 * 2. **Reading host components.** A season helper that reads a `Date`'s local
 *    parts answers differently on a Denver laptop and a UTC container. The
 *    `host indifference` blocks pin `process.env.TZ` either side of Greenwich
 *    with `withTimeZone` and require the SAME answer, so that class dies here
 *    rather than on somebody's machine.
 *
 * ## THE FIXTURE INSTANT IS THE FINANCIAL-YEAR BOUNDARY, ON PURPOSE
 *
 * `2026-04-01T00:00:00Z` is the one moment where the defect is a whole YEAR
 * rather than a day: `Pacific/Auckland` is already on 1 April (season 2026) while
 * `America/Denver` is still on 31 March (season 2025). The unit-test clock is
 * frozen at `2026-07-01T00:00:00.000Z`, where both zones agree on the season, so
 * a suite that used the default instant could not see this at all. The blocks
 * that need the boundary supply it explicitly through `fixedClubClock` - and the
 * one block that must exercise the DEFAULT clock pins its own system time and
 * hands the default instant back afterwards, per `AGENTS.md`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clubToday,
  dateOnlyInstantOf,
  fixedClubClock,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";
import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
  clubSeasonYear,
  seasonYearOfCalendarDate,
  seasonYearOfStoredDate,
} from "@/lib/financial-year";

import { withTimeZone } from "./helpers/timezone";

/** The default frozen instant, restored by the root hook - see `docs/TESTING.md`. */
const FROZEN_NOW = "2026-07-01T00:00:00.000Z";

/**
 * The financial-year boundary, as an instant. At this moment a club at UTC+13 is
 * on 1 April and a club at UTC-6 is still on 31 March, so the two answer with
 * season years a whole year apart.
 */
const SEASON_BOUNDARY = new Date("2026-04-01T00:00:00.000Z");

const AUCKLAND = requireClubTimeZone("Pacific/Auckland");
const DENVER = requireClubTimeZone("America/Denver");

/**
 * Hosts either side of Greenwich, plus the extremes. `Pacific/Kiritimati` is
 * UTC+14 and `Pacific/Pago_Pago` is UTC-11, so between them every possible sign
 * and magnitude of host offset is represented. A correct implementation returns
 * the same answer under all four; a host-local one does not.
 */
const HOSTS = [
  "UTC",
  "America/Denver",
  "Pacific/Auckland",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
] as const;

beforeEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});
afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

describe("seasonYearOfCalendarDate", () => {
  it("puts the season start month and everything after it in the current year", () => {
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-04-01"))).toBe(2026);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-12-31"))).toBe(2026);
  });

  it("puts the months before the season start in the previous year", () => {
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-03-31"))).toBe(2025);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-01-01"))).toBe(2025);
  });

  it("follows the club's configured year-end month", () => {
    __setFinancialYearEndMonthForTesting(6);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-07-01"))).toBe(2026);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-06-30"))).toBe(2025);

    __setFinancialYearEndMonthForTesting(12);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-01-01"))).toBe(2026);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2025-12-31"))).toBe(2025);
  });

  it("takes an explicit year-end month over the process cache", () => {
    __setFinancialYearEndMonthForTesting(3);
    expect(seasonYearOfCalendarDate(requireCalendarDate("2026-06-30"), 6)).toBe(2025);
  });

  it("answers the same on every host, because a calendar day has no zone", () => {
    // INV-DATE-019. The value under test is text, so there is nothing here for a
    // host offset to move - and that is exactly the property a host-local
    // implementation loses.
    for (const host of HOSTS) {
      withTimeZone(host, () => {
        expect(
          seasonYearOfCalendarDate(requireCalendarDate("2026-04-01")),
          `season year of 2026-04-01 under host ${host}`,
        ).toBe(2026);
        expect(
          seasonYearOfCalendarDate(requireCalendarDate("2026-03-31")),
          `season year of 2026-03-31 under host ${host}`,
        ).toBe(2025);
      });
    }
  });
});

describe("seasonYearOfStoredDate", () => {
  it("reads a @db.Date encoding as the calendar day it names", () => {
    expect(seasonYearOfStoredDate(new Date("2026-04-01T00:00:00.000Z"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2026-03-31T00:00:00.000Z"))).toBe(2025);
  });

  it("answers the same on every host — the encoding is defined in UTC", () => {
    // The mutant this kills is the retired body: reading 2026-04-01T00:00:00Z
    // with host-local getters answers 2025 on any host behind Greenwich, which
    // is a whole season year out on a stored lodge night.
    for (const host of HOSTS) {
      withTimeZone(host, () => {
        expect(
          seasonYearOfStoredDate(new Date("2026-04-01T00:00:00.000Z")),
          `stored 2026-04-01 under host ${host}`,
        ).toBe(2026);
      });
    }
  });

  it("refuses a value carrying a UTC time of day rather than flooring it", () => {
    // `calendarDateOfDateOnlyInstant` silently floors a real timestamp to its UTC
    // day (#3076), which for a club east of Greenwich is right for most of the day
    // and therefore the hardest kind of wrong to notice.
    expect(() => seasonYearOfStoredDate(new Date("2026-04-01T06:00:00.000Z"))).toThrow(
      /stored calendar day, not a moment/,
    );
    expect(() => seasonYearOfStoredDate(new Date("2026-04-01T00:00:00.001Z"))).toThrow(
      /stored calendar day, not a moment/,
    );
  });

  it("names clubSeasonYear in the refusal, because that is what the caller wanted", () => {
    expect(() => seasonYearOfStoredDate(new Date("2026-04-01T06:00:00.000Z"))).toThrow(
      /clubSeasonYear\(zone\)/,
    );
  });

  it("refuses an invalid Date instead of answering NaN", () => {
    expect(() => seasonYearOfStoredDate(new Date("not a date"))).toThrow(
      /valid Date holding a @db.Date/,
    );
  });

  it("follows the club's configured year-end month", () => {
    __setFinancialYearEndMonthForTesting(12);
    expect(seasonYearOfStoredDate(new Date("2026-01-01T00:00:00.000Z"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2025-12-31T00:00:00.000Z"))).toBe(2025);
  });
});

describe("clubSeasonYear — zone authority", () => {
  it("answers from the CLUB's calendar day, so two clubs differ on the boundary", () => {
    // The whole lane in one assertion. At this instant Auckland is on 1 April and
    // Denver is still on 31 March, so the season years are a year apart. Any
    // implementation that ignores its `zone` argument fails both halves at once.
    const clock = fixedClubClock(SEASON_BOUNDARY);
    expect(clubSeasonYear(AUCKLAND, clock)).toBe(2026);
    expect(clubSeasonYear(DENVER, clock)).toBe(2025);
  });

  it("gives the same pair of answers on every host", () => {
    const clock = fixedClubClock(SEASON_BOUNDARY);
    for (const host of HOSTS) {
      withTimeZone(host, () => {
        expect(
          clubSeasonYear(AUCKLAND, clock),
          `Auckland club on host ${host}`,
        ).toBe(2026);
        expect(clubSeasonYear(DENVER, clock), `Denver club on host ${host}`).toBe(
          2025,
        );
      });
    }
  });

  it("agrees with the club's own today, encoded and decoded", () => {
    // The round trip the retired function broke: encode the club's calendar day
    // as a `@db.Date` value and read it back. Group A measured that handing a
    // club-derived day to the host-local reader made a behind-UTC deployment
    // WORSE; these two paths must now agree for every club on every host.
    const clock = fixedClubClock(SEASON_BOUNDARY);
    for (const host of HOSTS) {
      withTimeZone(host, () => {
        for (const zone of [AUCKLAND, DENVER]) {
          expect(
            seasonYearOfStoredDate(dateOnlyInstantOf(clubToday(zone, clock))),
            `${zone} club, host ${host}`,
          ).toBe(clubSeasonYear(zone, clock));
        }
      });
    }
  });

  it("follows the club's configured year-end month", () => {
    const clock = fixedClubClock(new Date("2026-07-01T00:00:00.000Z"));
    __setFinancialYearEndMonthForTesting(6);
    // Auckland is on 1 July (the June year-end's first day of season 2026);
    // Denver is still on 30 June, the LAST day of season 2025.
    expect(clubSeasonYear(AUCKLAND, clock)).toBe(2026);
    expect(clubSeasonYear(DENVER, clock)).toBe(2025);
  });
});

describe("clubSeasonYear — the default clock", () => {
  // This block is the only one that exercises `systemClubClock`, so it needs the
  // system time ON the boundary rather than the default frozen instant (where
  // both zones agree and the assertion would be vacuous). `AGENTS.md`: a suite
  // may pin its own instant in its own hook, and the root re-freeze restores the
  // DEFAULT rather than a suite's pin, so this block hands it back explicitly.
  beforeEach(async () => {
    const { vi } = await import("vitest");
    vi.setSystemTime(SEASON_BOUNDARY);
  });
  afterAll(async () => {
    const { vi } = await import("vitest");
    vi.setSystemTime(new Date(FROZEN_NOW));
  });

  it("reads the clock when none is passed", () => {
    expect(clubSeasonYear(AUCKLAND)).toBe(2026);
    expect(clubSeasonYear(DENVER)).toBe(2025);
  });
});
