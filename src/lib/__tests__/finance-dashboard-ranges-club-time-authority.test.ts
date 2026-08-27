import { describe, expect, it, vi } from "vitest";

/**
 * #3123 — every date the finance dashboard renders is a CALENDAR value, so none
 * of them takes a zone, and the day that picks the reporting month arrives as
 * data. Both modules are covered here: the labels split out into
 * `finance-dashboard-labels.ts`, the reporting day stayed in
 * `finance-dashboard-ranges.ts`.
 *
 * Two separate defects, both closed here.
 *
 *  1. **The labels.** A `yyyy-MM` month key and a `yyyy-MM-dd` window bound are
 *     calendar concepts. `formatNZMonthYear(parseDateOnly(key))` and
 *     `formatNZDate(parseDateOnly(bound))` built a UTC-midnight instant and then
 *     projected it through `APP_TIME_ZONE`, which cancels only because New
 *     Zealand is east of Greenwich. For a club west of it every finance range
 *     heading named the PREVIOUS month and every window bound the previous day
 *     (`INV-DATE-019`). CT-4 corrected the trend axis that now sits beside them
 *     and left these two.
 *  2. **`today`.** Three `getTodayDateOnly()` reads chose the reporting month
 *     and the financial-year bucket from the CONTAINER's clock, so at a month
 *     boundary a whole finance figure landed in the wrong period. `today` is now
 *     required and threaded from the server boundary — `finance-dashboard-ranges.ts`
 *     is on the browser graph and may not read a zone at all.
 *
 * ## How this file discriminates
 *
 * `APP_TIME_ZONE` is pinned to `America/Denver`, BEHIND Greenwich, which is the
 * side the defect shows on. The assertions below then say the rendered day is
 * the STORED day. That is a live guard rather than scenery: if a future edit
 * puts any zone read back into either module — the container's or even the
 * club's — these produce Denver's answer and fail.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";
import { financeDashboardWindowDetail } from "@/lib/finance-dashboard-labels";
import {
  resolveFinanceDashboardSelection,
  resolvePrimaryFinanceRange,
} from "@/lib/finance-dashboard-ranges";

const MARCH_YEAR_END = 3;

/** The club's today, in the shape the server boundary threads in. */
function clubDay(day: string) {
  return dateOnlyInstantOf(requireCalendarDate(day));
}

describe("finance range labels take no zone (#3123)", () => {
  it("PREMISE: reading a stored day in the environment's zone shifts it", () => {
    /*
      Without this leg the cases below pass just as well on a machine whose zone
      agrees with UTC, and would read as a passing test of nothing.
    */
    const firstOfJune = new Date("2026-06-01T00:00:00.000Z");
    expect(
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: "America/Denver",
        dateStyle: "medium",
      }).format(firstOfJune),
    ).toBe("31 May 2026");
  });

  it("names the window bounds as the days they are, not the day before", () => {
    // BEFORE the migration: "31 May 2026 to 29 Jun 2026".
    expect(
      financeDashboardWindowDetail({ from: "2026-06-01", to: "2026-06-30" }),
    ).toBe("1 Jun 2026 to 30 Jun 2026");
  });

  it("names the range heading's month, not the previous one", () => {
    // BEFORE the migration this label read "May 2026" — a June figure under a
    // May heading, for any club west of Greenwich.
    const window = resolvePrimaryFinanceRange({
      option: "last-month",
      today: clubDay("2026-07-06"),
      financialYearEndMonth: MARCH_YEAR_END,
    });
    expect(window.fromMonth).toBe("2026-06");
    expect(window.label).toBe("June 2026");
  });

  it("keeps degrading to the raw text for a window it cannot read", () => {
    /*
      #2264's contract, preserved: `financeDashboardWindowDetail` is exported and
      takes plain strings, so a malformed window must produce a readable label
      rather than throw the whole finance page away. `parseCalendarDate` is
      slightly stricter than the `parseDateOnly` NaN check it replaces — it
      refuses a well-formed day that does not exist — which lands on the same
      side of the contract.
    */
    expect(
      financeDashboardWindowDetail({ from: "not-a-day", to: "2026-06-30" }),
    ).toBe("not-a-day to 30 Jun 2026");
    expect(
      financeDashboardWindowDetail({ from: "2026-02-30", to: "2026-06-30" }),
    ).toBe("2026-02-30 to 30 Jun 2026");
  });
});

describe("the reporting month comes from the supplied club day (#3123)", () => {
  it("honours the day it is given, across a month boundary", () => {
    /*
      The two days either side of a month end, which is where the old
      `getTodayDateOnly()` read of the container's clock moved a whole finance
      figure into the wrong period. Both are the same INSTANT for a club at
      UTC+12 and a club at UTC-6 — which is exactly why the caller, not this
      module, has to decide which day it is.
    */
    const lastOfJune = resolveFinanceDashboardSelection({
      today: clubDay("2026-06-30"),
      financialYearEndMonth: MARCH_YEAR_END,
    });
    const firstOfJuly = resolveFinanceDashboardSelection({
      today: clubDay("2026-07-01"),
      financialYearEndMonth: MARCH_YEAR_END,
    });
    expect(lastOfJune.currentMonth).toBe("2026-06");
    expect(firstOfJuly.currentMonth).toBe("2026-07");
    // "Last month" moves with it, and so does the figure behind it.
    expect(lastOfJune.primary.fromMonth).toBe("2026-05");
    expect(firstOfJuly.primary.fromMonth).toBe("2026-06");
  });

  it("puts the financial-year-to-date window on the supplied day's year", () => {
    const selection = resolveFinanceDashboardSelection({
      searchParams: { range: "financial-year-to-date" },
      today: clubDay("2026-07-01"),
      financialYearEndMonth: MARCH_YEAR_END,
    });
    expect(selection.primary.fromMonth).toBe("2026-04");
    expect(selection.primary.toMonth).toBe("2026-07");
  });
});
