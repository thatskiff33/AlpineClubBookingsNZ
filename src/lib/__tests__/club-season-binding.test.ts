/**
 * `bindClubSeason` picks the club's current season AND names it from one
 * server-resolved year-end (#5259).
 *
 * The defect it closes: a browser screen read `financial-year.ts`'s process
 * cache, which no browser ever seeds, so a June-year-end club was shown March
 * seasons on both halves. The bug each case would catch:
 *
 * - **March** is the no-change control: today's clubs must see the same season
 *   and the same text as before.
 * - **June** is the issue's own example. On 15 June 2026 the club's season is the
 *   one ENDING June 2026, so its season year is 2025, not 2026; a binding that
 *   passed the year-end to the label but not to the season year picks 2026.
 * - **December** is the single-calendar-year season, `"2026 (Jan-Dec)"`.
 *
 * The process cache is deliberately set to a fourth value first, so a binding
 * that still read it answers wrongly in every case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fixedClubClock,
  requireClubTimeZone,
  requireInstant,
} from "@/lib/club-time";
import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
} from "@/lib/financial-year";
import { bindClubSeason } from "@/lib/season-label";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const club = {
  zone: requireClubTimeZone("Pacific/Auckland"),
  format: CLUB_FORMAT_TEST,
};
/** Noon on 15 June 2026 in New Zealand. */
const MID_JUNE = fixedClubClock(requireInstant("2026-06-15T00:00:00.000Z"));

beforeEach(() => {
  __setFinancialYearEndMonthForTesting(9);
});

afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

describe("bindClubSeason on 15 June 2026", () => {
  it.each([
    [3, 2026, "2026 - 2027 (Apr-Mar)"],
    [6, 2025, "2025 - 2026 (Jul-Jun)"],
    [12, 2026, "2026 (Jan-Dec)"],
  ])(
    "a year-end of month %i is in season %i, named %s",
    (yearEndMonth, seasonYear, label) => {
      const season = bindClubSeason(yearEndMonth, club, MID_JUNE);
      expect(season.yearEndMonth).toBe(yearEndMonth);
      expect(season.currentSeasonYear()).toBe(seasonYear);
      expect(season.selectLabel(season.currentSeasonYear())).toBe(label);
    },
  );

  it("rolls a June club into its next season on 1 July, in the club's zone", () => {
    // 30 June 2026 12:30 UTC is 1 July 00:30 in New Zealand: the club's day,
    // not the host's or UTC's, decides the season.
    const justAfterMidnight = fixedClubClock(
      requireInstant("2026-06-30T12:30:00.000Z"),
    );
    expect(bindClubSeason(6, club, justAfterMidnight).currentSeasonYear()).toBe(
      2026,
    );
  });

  it("clamps a nonsense year-end to March, as the server resolver does", () => {
    const season = bindClubSeason(13, club, MID_JUNE);
    expect(season.yearEndMonth).toBe(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    expect(season.selectLabel(2026)).toBe("2026 - 2027 (Apr-Mar)");
  });
});
