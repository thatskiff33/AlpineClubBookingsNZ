/**
 * The membership-season label follows the club's year-end, not a literal April.
 *
 * `src/app/(admin)/admin/subscriptions/page.tsx` rendered
 * `{y} - {y + 1} (Apr-Mar)` with both halves written out as text. CT-4 group F1
 * (#2870) moved the season YEAR on that page onto the shared derivation and left
 * this label as an acknowledged deferral; `src/lib/season-label.ts` closes it.
 *
 * ## What each case is for
 *
 * - **March** is the shipped default, so it is the no-change control: it must
 *   render the OLD literal byte for byte, or this refactor moved a live pixel.
 * - **December** is the discriminator for the years half. Its season starts in
 *   January, so `seasonYearOfCalendarDate` returns the calendar year itself, and
 *   a label reading "2026 - 2027" would contradict the derivation it labels. A
 *   test that only checked the month names would pass with the years half still
 *   hard-coded.
 * - **June** is the ordinary configured case, where both halves move and the
 *   season still straddles two calendar years.
 * - **January** is the far edge: a January year-end starts the season in
 *   February, so the label runs Feb-Jan and the years still straddle.
 *
 * ## The host axis
 *
 * A month name is rendered from a calendar day, which has no timezone
 * (`INV-DATE-019`), through the kernel's UTC-pinned formatter — so the answer
 * must be identical on a host behind Greenwich, which is where every date defect
 * this epic found actually bites. `Pacific/Pago_Pago` is UTC-11 and
 * `Pacific/Kiritimati` is UTC+14, so the pair straddles the date line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
  getSeasonStartMonth,
  seasonYearOfCalendarDate,
} from "@/lib/financial-year";
import { calendarDateFromParts } from "@/lib/club-time";
import {
  seasonMonthsLabel,
  seasonSelectLabel,
  seasonYearsLabel,
} from "@/lib/season-label";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

beforeEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

describe("seasonSelectLabel", () => {
  it("renders the shipped default exactly as the hard-coded label did", () => {
    // The literal that shipped, reproduced here rather than referenced, so a
    // change to the rendered text has to be made on purpose.
    expect(seasonSelectLabel(2026)).toBe("2026 - 2027 (Apr-Mar)");
    expect(DEFAULT_FINANCIAL_YEAR_END_MONTH).toBe(3);
  });

  it.each([
    [3, "2026 - 2027 (Apr-Mar)"],
    [6, "2026 - 2027 (Jul-Jun)"],
    [12, "2026 (Jan-Dec)"],
    [1, "2026 - 2027 (Feb-Jan)"],
  ])("follows a year-end of month %i", (yearEndMonth, expected) => {
    __setFinancialYearEndMonthForTesting(yearEndMonth);
    expect(seasonSelectLabel(2026)).toBe(expected);
  });

  it("agrees with the season derivation about whether one year or two", () => {
    // The property the December case exists to protect, asserted as a property
    // rather than as a string: the label names two calendar years exactly when
    // the derivation puts the season's first and last months in two of them.
    for (const yearEndMonth of [1, 2, 3, 6, 11, 12]) {
      __setFinancialYearEndMonthForTesting(yearEndMonth);
      const startMonth = getSeasonStartMonth();
      // The season's first day, and the day 11 months later, which is its last
      // month. Their season year is the same by construction; whether their
      // CALENDAR years differ is the question the label answers.
      const firstMonth = calendarDateFromParts(2026, startMonth, 1);
      const lastMonthYear = startMonth === 1 ? 2026 : 2027;
      const lastMonth = calendarDateFromParts(lastMonthYear, yearEndMonth, 1);
      expect(seasonYearOfCalendarDate(firstMonth)).toBe(2026);
      expect(seasonYearOfCalendarDate(lastMonth)).toBe(2026);
      expect(seasonYearsLabel(2026)).toBe(
        lastMonthYear === 2026 ? "2026" : "2026 - 2027",
      );
    }
  });

  it("names the months independently of which season is being labelled", () => {
    __setFinancialYearEndMonthForTesting(6);
    expect(seasonMonthsLabel()).toBe("Jul-Jun");
    for (const seasonYear of [1999, 2026, 2400]) {
      expect(seasonSelectLabel(seasonYear)).toBe(
        `${seasonYear} - ${seasonYear + 1} (Jul-Jun)`,
      );
    }
  });

  it("HOST AXIS: the same label on a host either side of the date line", () => {
    for (const yearEndMonth of [3, 12]) {
      __setFinancialYearEndMonthForTesting(yearEndMonth);
      const expected = seasonSelectLabel(2026);
      for (const zone of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
        withTimeZone(zone, () => {
          expect(seasonSelectLabel(2026)).toBe(expected);
        });
      }
    }
  });
});
