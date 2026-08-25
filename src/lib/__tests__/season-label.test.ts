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
 * - **August and September** are the only year-ends whose label is not 21
 *   characters, because en-NZ abbreviates September to `"Sept"` and every other
 *   month to three letters. Nothing else in this suite renders a four-character
 *   month, and a consumer that had assumed a fixed width would be wrong here.
 *
 * Every twelve-month property below sweeps ALL TWELVE year-ends rather than a
 * sample. The derivation is a modular rollover, so the interesting cases are the
 * two wrap points (1 and 12) — but a sampled sweep is how a table comes to look
 * exhaustive while leaving half the domain unexercised, and iterating twelve
 * integers costs nothing.
 *
 * ## The host axis, and why there are TWO host cases
 *
 * A month name is rendered from a calendar day, which has no timezone
 * (`INV-DATE-019`), through the kernel's UTC-pinned formatter — so the answer
 * must be identical on a host behind Greenwich, which is where every date defect
 * this epic found actually bites. The first case straddles the date line
 * (`Pacific/Pago_Pago` is UTC-11, `Pacific/Kiritimati` is UTC+14). The second
 * re-imports the module graph first, and the comment on it explains why the
 * first case alone cannot reach the kernel's formatter construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
  getFinancialYearEndMonth,
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

/** 1..12, so no sweep below has to decide which year-ends are interesting. */
const EVERY_YEAR_END_MONTH = Array.from({ length: 12 }, (_, i) => i + 1);

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
    // The two four-character-month year-ends. 8 puts "Sept" first, 9 puts it
    // last, so a join that mishandled either end is visible.
    [8, "2026 - 2027 (Sept-Aug)"],
    [9, "2026 - 2027 (Oct-Sept)"],
  ])("follows a year-end of month %i", (yearEndMonth, expected) => {
    __setFinancialYearEndMonthForTesting(yearEndMonth);
    expect(seasonSelectLabel(2026)).toBe(expected);
  });

  it("agrees with the season derivation about whether one year or two", () => {
    // The property the December case exists to protect, asserted as a property
    // rather than as a string: the label names two calendar years exactly when
    // the derivation puts the season's first and last months in two of them.
    for (const yearEndMonth of EVERY_YEAR_END_MONTH) {
      __setFinancialYearEndMonthForTesting(yearEndMonth);
      const startMonth = getSeasonStartMonth();
      // The season's first day, and the day 11 months later, which is its last
      // month. Their season year is the same by construction; whether their
      // CALENDAR years differ is the question the label answers.
      const firstMonth = calendarDateFromParts(2026, startMonth, 1);
      const lastMonthYear = startMonth === 1 ? 2026 : 2027;
      const lastMonth = calendarDateFromParts(lastMonthYear, yearEndMonth, 1);
      expect(seasonYearOfCalendarDate(firstMonth), `year-end ${yearEndMonth}`)
        .toBe(2026);
      expect(seasonYearOfCalendarDate(lastMonth), `year-end ${yearEndMonth}`)
        .toBe(2026);
      expect(seasonYearsLabel(2026), `year-end ${yearEndMonth}`).toBe(
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

  it("fits the picker's fixed-width trigger for every year-end", () => {
    /*
      The select trigger is `w-48` and the label is the only thing in it. Eleven
      year-ends give 21 characters and the two September ones give 22, because
      en-NZ writes "Sept". No defect — this records the measurement so that a
      later shape change (a longer separator, a spelled-out month) has to notice
      it is widening a fixed control rather than discovering it in a screenshot.
    */
    const widths = new Map<number, number>();
    for (const yearEndMonth of EVERY_YEAR_END_MONTH) {
      widths.set(yearEndMonth, seasonSelectLabel(2026, yearEndMonth).length);
    }
    expect(widths.get(12)).toBe(14); // "2026 (Jan-Dec)" — the single-year form
    expect(widths.get(8)).toBe(22);
    expect(widths.get(9)).toBe(22);
    for (const yearEndMonth of EVERY_YEAR_END_MONTH) {
      if ([8, 9, 12].includes(yearEndMonth)) continue;
      expect(widths.get(yearEndMonth), `year-end ${yearEndMonth}`).toBe(21);
    }
  });
});

describe("the explicit yearEndMonth argument", () => {
  /*
    Every sibling derivation in `financial-year.ts` takes the year-end as an
    optional override — `seasonYearOfCalendarDate(date, m)`,
    `seasonYearOfStoredDate(value, m)`, `clubSeasonYear(zone, clock, m)` — and
    these three match it. The point is not symmetry: a SERVER caller that already
    holds the club's year-end can render a label for it without writing to a
    process-global cache, and when the value is finally plumbed to the client the
    cheapest path this API leaves open is a call from a client provider, which
    would be a module-global write during mount feeding a string read during
    render. That is a manufactured hydration mismatch. Passing the value cannot
    produce one.
  */
  it("matches the cached path for every year-end, both halves", () => {
    // The discriminating assertion in this file for the override being wired
    // through BOTH halves. Wire it into `seasonYearsLabel` only and the months
    // stay Apr-Mar; wire it into `seasonMonthsLabel` only and December still
    // reads "2026 - 2027". Either way this fails.
    for (const yearEndMonth of EVERY_YEAR_END_MONTH) {
      const viaArgument = seasonSelectLabel(2026, yearEndMonth);
      __setFinancialYearEndMonthForTesting(yearEndMonth);
      const viaCache = seasonSelectLabel(2026);
      __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
      expect(viaArgument, `year-end ${yearEndMonth}`).toBe(viaCache);
    }
  });

  it("reads the argument, not the cache, and writes nothing back", () => {
    expect(getFinancialYearEndMonth()).toBe(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    expect(seasonSelectLabel(2026, 12)).toBe("2026 (Jan-Dec)");
    expect(seasonMonthsLabel(6)).toBe("Jul-Jun");
    expect(seasonYearsLabel(2026, 12)).toBe("2026");
    // The cache is untouched, which is the whole point of the argument.
    expect(getFinancialYearEndMonth()).toBe(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    expect(seasonSelectLabel(2026)).toBe("2026 - 2027 (Apr-Mar)");
  });

  it("clamps a nonsense year-end the same way the cache setter does", () => {
    // `normalizeYearEndMonth` falls back to March rather than throwing, and a
    // caller passing a value straight out of a settings payload gets that
    // behaviour rather than a different one.
    expect(seasonSelectLabel(2026, 0)).toBe("2026 - 2027 (Apr-Mar)");
    expect(seasonSelectLabel(2026, 13)).toBe("2026 - 2027 (Apr-Mar)");
    expect(seasonSelectLabel(2026, Number.NaN)).toBe("2026 - 2027 (Apr-Mar)");
  });
});

describe("the host machine cannot move a month name", () => {
  it("renders the same label either side of the date line", () => {
    // The premise first: two host zones that resolve the same prove nothing.
    expect(
      withTimeZone("Pacific/Pago_Pago", () =>
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("Pacific/Pago_Pago");

    for (const yearEndMonth of EVERY_YEAR_END_MONTH) {
      __setFinancialYearEndMonthForTesting(yearEndMonth);
      const expected = withTimeZone("UTC", () => seasonSelectLabel(2026));
      for (const zone of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
        withTimeZone(zone, () => {
          expect(seasonSelectLabel(2026), `${zone} / ${yearEndMonth}`).toBe(
            expected,
          );
        });
      }
    }
  });

  it("holds on a graph whose formatter is BUILT under a behind-UTC host", async () => {
    /*
      THE CASE ABOVE CANNOT KILL A MUTATION THAT DROPS `timeZone` FROM THE
      KERNEL'S `formatterFor` CONSTRUCTION, and the reason is worth writing down
      rather than leaving as a gap someone re-discovers. `club-time/intl.ts` memos
      formatters in a module-level `Map` with no reset seam, so by the time any
      `withTimeZone` block in this file runs, the `shortMonth` formatter has
      already been constructed — under whatever host the earlier cases ran on. A
      host-only mutation then reads a formatter that was built correctly, and two
      host zones agree because they are both reading the same cached object.

      `vi.resetModules()` plus a dynamic import is the mechanism that reaches it:
      this epic measured that a module-load `Intl` pin survives `withTimeZone` and
      needs the re-imported graph. The formatter is built lazily on the first
      format call, so the import may sit outside the pin as long as the CALL is
      inside it.

      `Pacific/Pago_Pago` is UTC-11, so a formatter that lost its `"UTC"` pin
      reads 2001-04-01T00:00:00Z as 31 March and 2001-03-01T00:00:00Z as 28
      February: the label becomes "Mar-Feb" rather than "Apr-Mar".
    */
    vi.resetModules();
    const fresh = await import("@/lib/season-label");
    // A fresh graph means a fresh financial-year cache, so this is the March
    // default by construction rather than by this file's beforeEach.
    withTimeZone("Pacific/Pago_Pago", () => {
      expect(fresh.seasonMonthsLabel()).toBe("Apr-Mar");
      expect(fresh.seasonSelectLabel(2026)).toBe("2026 - 2027 (Apr-Mar)");
      expect(fresh.seasonMonthsLabel(12)).toBe("Jan-Dec");
    });
  });
});
