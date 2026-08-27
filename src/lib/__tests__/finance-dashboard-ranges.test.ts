import { describe, expect, it } from "vitest";
import {
  FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS,
  FINANCE_DASHBOARD_VIEWS,
  financeDashboardMonthCount,
  financeDashboardViewUsesLodgeScope,
  financeDashboardWindowMonths,
  resolveComparisonFinanceRange,
  resolveFinanceDashboardSelection,
  resolveFinanceDashboardView,
  resolvePrimaryFinanceRange,
} from "@/lib/finance-dashboard-ranges";
import { financeDashboardWindowDetail } from "@/lib/finance-dashboard-labels";
import { parseDateOnly } from "@/lib/date-only";

// 6 July 2026: the in-progress month is July, last completed month is June.
const TODAY = parseDateOnly("2026-07-06");
const MARCH_YEAR_END = 3;

describe("resolvePrimaryFinanceRange", () => {
  it("resolves last-month to the last completed month", () => {
    const window = resolvePrimaryFinanceRange({
      option: "last-month",
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(window).toMatchObject({
      fromMonth: "2026-06",
      toMonth: "2026-06",
      from: "2026-06-01",
      to: "2026-06-30",
      label: "June 2026",
    });
  });

  it.each([
    ["last-3-months", "2026-04"],
    ["last-6-months", "2026-01"],
    ["last-12-months", "2025-07"],
  ] as const)("resolves %s ending at the last completed month", (option, fromMonth) => {
    const window = resolvePrimaryFinanceRange({
      option,
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(window.fromMonth).toBe(fromMonth);
    expect(window.toMonth).toBe("2026-06");
  });

  it("resolves financial-year-to-date including the in-progress month (March year-end)", () => {
    const window = resolvePrimaryFinanceRange({
      option: "financial-year-to-date",
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(window).toMatchObject({
      fromMonth: "2026-04",
      toMonth: "2026-07",
      from: "2026-04-01",
      to: "2026-07-31",
    });
    expect(window.label).toContain("FY2027 to date");
  });

  it("resolves financial-year-to-date in the first month of the financial year", () => {
    const window = resolvePrimaryFinanceRange({
      option: "financial-year-to-date",
      today: parseDateOnly("2026-04-02"),
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(window.fromMonth).toBe("2026-04");
    expect(window.toMonth).toBe("2026-04");
  });

  it("resolves financial-year-to-date for a December year-end", () => {
    const window = resolvePrimaryFinanceRange({
      option: "financial-year-to-date",
      today: TODAY,
      financialYearEndMonth: 12,
    });

    expect(window.fromMonth).toBe("2026-01");
    expect(window.toMonth).toBe("2026-07");
    expect(window.label).toContain("FY2026 to date");
  });

  it("resolves last-financial-year as the previous complete April-to-March year", () => {
    const window = resolvePrimaryFinanceRange({
      option: "last-financial-year",
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(window).toMatchObject({
      fromMonth: "2025-04",
      toMonth: "2026-03",
      from: "2025-04-01",
      to: "2026-03-31",
    });
    expect(window.label).toContain("FY2026");
  });

  it("accepts custom month keys", () => {
    const warnings: string[] = [];
    const window = resolvePrimaryFinanceRange({
      option: "custom",
      searchParams: { from: "2026-01", to: "2026-03" },
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
      warnings,
    });

    expect(window).toMatchObject({
      fromMonth: "2026-01",
      toMonth: "2026-03",
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(warnings).toEqual([]);
  });

  it("clamps legacy day-level custom params to whole months with a warning", () => {
    const warnings: string[] = [];
    const window = resolvePrimaryFinanceRange({
      option: "custom",
      searchParams: { from: "2026-01-15", to: "2026-03-20" },
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
      warnings,
    });

    expect(window.fromMonth).toBe("2026-01");
    expect(window.toMonth).toBe("2026-03");
    expect(window.to).toBe("2026-03-31");
    expect(warnings.some((warning) => warning.includes("whole months"))).toBe(true);
  });

  it("falls back to last month when custom months are reversed", () => {
    const warnings: string[] = [];
    const window = resolvePrimaryFinanceRange({
      option: "custom",
      searchParams: { from: "2026-05", to: "2026-02" },
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
      warnings,
    });

    expect(window.fromMonth).toBe("2026-06");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveComparisonFinanceRange", () => {
  const primary = resolvePrimaryFinanceRange({
    option: "last-3-months",
    today: TODAY,
    financialYearEndMonth: MARCH_YEAR_END,
  });

  it("resolves previous-period to the same-length window immediately before", () => {
    const window = resolveComparisonFinanceRange({
      option: "previous-period",
      primary,
    });

    expect(window).toMatchObject({
      fromMonth: "2026-01",
      toMonth: "2026-03",
    });
  });

  it("resolves same-period-last-year to the same months a year earlier", () => {
    const window = resolveComparisonFinanceRange({
      option: "same-period-last-year",
      primary,
    });

    expect(window).toMatchObject({
      fromMonth: "2025-04",
      toMonth: "2025-06",
    });
  });

  it("resolves none to null", () => {
    expect(
      resolveComparisonFinanceRange({ option: "none", primary })
    ).toBeNull();
  });

  it("resolves custom comparison months", () => {
    const window = resolveComparisonFinanceRange({
      option: "custom",
      primary,
      searchParams: { compareFrom: "2024-04", compareTo: "2024-06" },
    });

    expect(window).toMatchObject({
      fromMonth: "2024-04",
      toMonth: "2024-06",
    });
  });
});

describe("resolveFinanceDashboardSelection", () => {
  it("defaults to last-month vs previous-period on the bookings view", () => {
    const selection = resolveFinanceDashboardSelection({
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(selection).toMatchObject({
      view: "bookings",
      range: "last-month",
      compare: "previous-period",
      currentMonth: "2026-07",
      financialYearEndMonth: MARCH_YEAR_END,
    });
    expect(selection.primary.fromMonth).toBe("2026-06");
    expect(selection.comparison?.fromMonth).toBe("2026-05");
  });

  it("maps legacy range and compare option values onto month-granular ones", () => {
    const selection = resolveFinanceDashboardSelection({
      searchParams: { range: "last-quarter", compare: "previous-month" },
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(selection.range).toBe("last-3-months");
    expect(selection.compare).toBe("previous-period");
  });

  it("carries a null comparison window through for compare=none", () => {
    const selection = resolveFinanceDashboardSelection({
      searchParams: { compare: "none" },
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(selection.comparison).toBeNull();
    expect(financeDashboardWindowDetail(selection.comparison)).toBe("None");
  });

  it("falls back to defaults on unknown option values", () => {
    const selection = resolveFinanceDashboardSelection({
      searchParams: { range: "fortnightly", compare: "vibes" },
      today: TODAY,
      financialYearEndMonth: MARCH_YEAR_END,
    });

    expect(selection.range).toBe("last-month");
    expect(selection.compare).toBe("previous-period");
  });
});

describe("month window helpers", () => {
  it("counts months inclusively and enumerates them oldest first", () => {
    const window = { fromMonth: "2025-11", toMonth: "2026-02" };

    expect(financeDashboardMonthCount(window)).toBe(4);
    expect(financeDashboardWindowMonths(window)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

// #2919 review. The page builder has to know the view BEFORE it reads the
// seasons (the seasons' lodge scope depends on it), and the client has to know
// which views render the lodge selector. Both now ask these two helpers, so the
// rules have one definition each — these tests are what stops the standalone
// view resolver drifting from the one inside the selection resolver.
describe("the view resolver and the lodge-scope predicate", () => {
  it("resolves the view identically to the full selection resolver", () => {
    const cases: Array<Record<string, string | string[] | undefined> | undefined> =
      [
        undefined,
        {},
        { view: "revenue" },
        { view: "pricing-sensitivity" },
        { view: "balance-sheet" },
        { view: "not-a-view" },
        { view: ["cash", "revenue"] },
      ];

    for (const searchParams of cases) {
      expect(resolveFinanceDashboardView(searchParams)).toBe(
        resolveFinanceDashboardSelection({
          searchParams,
          today: TODAY,
          financialYearEndMonth: MARCH_YEAR_END,
        }).view
      );
    }
  });

  it("reads no seasons, so a caller may resolve it before it loads any", () => {
    // The whole point: no `seasons` argument exists to pass.
    expect(resolveFinanceDashboardView({ view: "cash" })).toBe("cash");
    expect(resolveFinanceDashboardView({ view: "bogus" })).toBe("bookings");
  });

  it("scopes only the two booking-derived views to a lodge", () => {
    const scoped = FINANCE_DASHBOARD_VIEWS.filter(
      financeDashboardViewUsesLodgeScope
    );

    expect(scoped).toEqual(["bookings", "pricing-sensitivity"]);
    expect(FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS).toEqual(scoped);
  });
});
