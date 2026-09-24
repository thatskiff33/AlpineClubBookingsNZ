import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListMonthlyFacts, mockListFinanceReportCategories } = vi.hoisted(
  () => ({
    mockListMonthlyFacts: vi.fn(),
    mockListFinanceReportCategories: vi.fn(),
  })
);

vi.mock("@/lib/finance-monthly-fact-store", () => ({
  listMonthlyFacts: mockListMonthlyFacts,
}));

vi.mock("@/lib/finance-report-mappings", () => ({
  UNMAPPED_FINANCE_CATEGORY_ID: "unmapped",
  listFinanceReportCategories: mockListFinanceReportCategories,
}));

import { buildFinanceMonthlyPnlSummary } from "@/lib/finance-monthly-pnl";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

interface FactSeed {
  month: string;
  accountCode: string;
  accountName: string;
  accountClass: "REVENUE" | "EXPENSE" | null;
  amountCents: number;
  isProvisional?: boolean;
}

function fact(seed: FactSeed) {
  return {
    statementKind: "PROFIT_AND_LOSS",
    month: seed.month,
    accountCode: seed.accountCode,
    accountId: `acc-${seed.accountCode}`,
    accountName: seed.accountName,
    accountType: seed.accountClass === "REVENUE" ? "SALES" : "EXPENSE",
    accountClass: seed.accountClass,
    amountCents: seed.amountCents,
    currency: "NZD",
    isProvisional: seed.isProvisional ?? false,
    sourceReport: "getReportProfitAndLoss",
    syncedAt: new Date("2026-07-06T10:15:00.000Z"),
  };
}

const PRIMARY = { fromMonth: "2026-04", toMonth: "2026-06", label: "April 2026 to June 2026" };
const COMPARISON = { fromMonth: "2026-01", toMonth: "2026-03", label: "January 2026 to March 2026" };

function categories() {
  return [
    {
      id: "cat-hut",
      kind: "REVENUE",
      name: "Hut Fees",
      subtype: "Operating",
      sortOrder: 10,
      archived: false,
      mappings: [{ accountCode: "200" }],
    },
    {
      id: "cat-catering",
      kind: "EXPENSE",
      name: "Catering",
      subtype: "Operations",
      sortOrder: 10,
      archived: false,
      mappings: [{ accountCode: "310" }],
    },
  ];
}

function primaryFacts() {
  return [
    fact({ month: "2026-04", accountCode: "200", accountName: "Hut Fees", accountClass: "REVENUE", amountCents: 120_000 }),
    fact({ month: "2026-05", accountCode: "200", accountName: "Hut Fees", accountClass: "REVENUE", amountCents: 180_050 }),
    fact({ month: "2026-06", accountCode: "200", accountName: "Hut Fees", accountClass: "REVENUE", amountCents: 90_000 }),
    fact({ month: "2026-05", accountCode: "260", accountName: "Donations", accountClass: "REVENUE", amountCents: 25_000 }),
    fact({ month: "2026-05", accountCode: "310", accountName: "Catering", accountClass: "EXPENSE", amountCents: 40_000 }),
  ];
}

function comparisonFacts() {
  return [
    fact({ month: "2026-01", accountCode: "200", accountName: "Hut Fees", accountClass: "REVENUE", amountCents: 100_000 }),
    fact({ month: "2026-03", accountCode: "260", accountName: "Donations", accountClass: "REVENUE", amountCents: 10_000 }),
    fact({ month: "2026-02", accountCode: "310", accountName: "Catering", accountClass: "EXPENSE", amountCents: 30_000 }),
  ];
}

describe("buildFinanceMonthlyPnlSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFinanceReportCategories.mockResolvedValue(categories());
    mockListMonthlyFacts.mockImplementation(
      async (input: { fromMonth: string }) =>
        input.fromMonth === PRIMARY.fromMonth ? primaryFacts() : comparisonFacts()
    );
  });

  it("sums only the view's rows, groups by mapping, and keeps unmapped visible", async () => {
    const summary = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: COMPARISON,
      currentMonth: "2026-07",
    });

    // 120,000 + 180,050 + 90,000 mapped hut fees + 25,000 unmapped donations.
    expect(summary.amountCents).toBe(415_050);
    expect(summary.comparisonAmountCents).toBe(110_000);
    expect(summary.formattedAmount).toBe("$4,151");
    expect(summary.formattedDelta).toBe("+$3,051");

    const hutGroup = summary.groups.find((group) => group.id === "cat-hut");
    expect(hutGroup).toMatchObject({
      amountCents: 390_050,
      comparisonAmountCents: 100_000,
      lineCount: 1,
    });
    const unmapped = summary.groups.find((group) => group.id === "unmapped");
    expect(unmapped).toMatchObject({ amountCents: 25_000, lineCount: 1 });
    expect(summary.mix.map((item) => item.name)).toContain("Unmapped");
  });

  it("builds one trend point per month with a positionally aligned comparison", async () => {
    const summary = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: COMPARISON,
      currentMonth: "2026-06",
    });

    expect(summary.trend).toEqual([
      expect.objectContaining({
        monthKey: "2026-04",
        label: "Apr 2026",
        amountCents: 120_000,
        comparisonAmountCents: 100_000, // 2026-01 aligns with month 1
        isProvisional: false,
      }),
      expect.objectContaining({
        monthKey: "2026-05",
        amountCents: 180_050 + 25_000,
        comparisonAmountCents: 0, // 2026-02 had no revenue rows
        isProvisional: false,
      }),
      expect.objectContaining({
        monthKey: "2026-06",
        amountCents: 90_000,
        comparisonAmountCents: 10_000, // 2026-03 donations
        isProvisional: true,
      }),
    ]);
  });

  it("honours treasurer mappings over the Xero account class", async () => {
    mockListFinanceReportCategories.mockResolvedValue([
      ...categories(),
      {
        id: "cat-fundraising-costs",
        kind: "EXPENSE",
        name: "Fundraising",
        subtype: null,
        sortOrder: 20,
        archived: false,
        // Deliberately maps a REVENUE-class account into an expense group.
        mappings: [{ accountCode: "260" }],
      },
    ]);

    const revenue = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
    });
    const costs = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "EXPENSE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
    });

    expect(revenue.amountCents).toBe(390_050);
    const fundraising = costs.groups.find(
      (group) => group.id === "cat-fundraising-costs"
    );
    expect(fundraising?.amountCents).toBe(25_000);
  });

  it("keeps an unclassed unmapped account in the costs view, not dropped from both", async () => {
    mockListMonthlyFacts.mockImplementation(
      async (input: { fromMonth: string }) =>
        input.fromMonth === PRIMARY.fromMonth
          ? [
              fact({ month: "2026-05", accountCode: "310", accountName: "Catering", accountClass: "EXPENSE", amountCents: 40_000 }),
              // Unmapped account with no Xero class (e.g. missing from a stale
              // chart snapshot). It must land in exactly one view, not vanish
              // from both, so the "unmapped stays in totals" promise holds.
              fact({ month: "2026-05", accountCode: "990", accountName: "Sundry", accountClass: null, amountCents: 12_000 }),
            ]
          : []
    );

    const costs = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "EXPENSE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
    });
    const revenue = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
    });

    // Costs keeps the unclassed line, in the Unmapped group and the total,
    // matching the ratio explorer's "unclassed counts as expense" rule.
    expect(costs.amountCents).toBe(52_000);
    expect(costs.groups.find((group) => group.id === "unmapped")).toMatchObject({
      amountCents: 12_000,
      lineCount: 1,
    });
    // Revenue excludes it, confirming it is not double-counted or dropped.
    expect(revenue.amountCents).toBe(0);
  });

  it("returns null comparison fields when no comparison window is selected", async () => {
    const summary = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
    });

    expect(summary.comparisonAmountCents).toBeNull();
    expect(summary.formattedComparisonAmount).toBeNull();
    expect(summary.formattedDelta).toBeNull();
    expect(summary.trend.every((point) => point.comparisonAmountCents === null)).toBe(
      true
    );
    expect(mockListMonthlyFacts).toHaveBeenCalledTimes(1);
  });

  it("applies expense category and line filters after building filter options", async () => {
    mockListMonthlyFacts.mockImplementation(async () => [
      fact({ month: "2026-05", accountCode: "310", accountName: "Catering", accountClass: "EXPENSE", amountCents: 40_000 }),
      fact({ month: "2026-05", accountCode: "320", accountName: "Power", accountClass: "EXPENSE", amountCents: 15_000 }),
    ]);

    const summary = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "EXPENSE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
      expenseCategoryId: "cat-catering",
    });

    expect(summary.amountCents).toBe(40_000);
    expect(summary.availableExpenseLines.map((line) => line.value)).toEqual([
      "310",
      "320",
    ]);
  });

  it("warns about missing months, empty ranges, and provisional data", async () => {
    mockListMonthlyFacts.mockImplementation(
      async (input: { fromMonth: string }) =>
        input.fromMonth === PRIMARY.fromMonth
          ? [
              fact({
                month: "2026-06",
                accountCode: "200",
                accountName: "Hut Fees",
                accountClass: "REVENUE",
                amountCents: 90_000,
                isProvisional: true,
              }),
            ]
          : []
    );

    const summary = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: COMPARISON,
      currentMonth: "2026-06",
    });

    expect(summary.warnings.some((warning) => warning.includes("covers 1 of 3"))).toBe(
      true
    );
    expect(
      summary.warnings.some((warning) => warning.includes("comparison period"))
    ).toBe(true);
    expect(
      summary.warnings.some((warning) => warning.includes("month-to-date"))
    ).toBe(true);

    mockListMonthlyFacts.mockResolvedValue([]);
    const empty = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-07",
    });
    expect(
      empty.warnings.some((warning) =>
        warning.includes("No monthly Xero data is stored")
      )
    ).toBe(true);
  });

  it("trusts the stored provisional flag when the sync stalled in an earlier month", async () => {
    // Sync last ran mid-May: May's facts are still flagged provisional even
    // though the calendar has moved on to June.
    mockListMonthlyFacts.mockImplementation(
      async (input: { fromMonth: string }) =>
        input.fromMonth === PRIMARY.fromMonth
          ? [
              fact({ month: "2026-04", accountCode: "200", accountName: "Hut Fees", accountClass: "REVENUE", amountCents: 120_000 }),
              fact({
                month: "2026-05",
                accountCode: "200",
                accountName: "Hut Fees",
                accountClass: "REVENUE",
                amountCents: 80_000,
                isProvisional: true,
              }),
            ]
          : []
    );

    const summary = await buildFinanceMonthlyPnlSummary({
      format: CLUB_FORMAT_TEST,
      kind: "REVENUE",
      primary: PRIMARY,
      comparison: null,
      currentMonth: "2026-06",
    });

    const may = summary.trend.find((point) => point.monthKey === "2026-05");
    expect(may?.isProvisional).toBe(true);
    const provisionalWarning = summary.warnings.find((warning) =>
      warning.includes("month-to-date")
    );
    expect(provisionalWarning).toContain("May 2026");
    expect(provisionalWarning).not.toContain("Jun 2026");
  });
});
