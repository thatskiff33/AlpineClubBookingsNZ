import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListMonthlyFacts } = vi.hoisted(() => ({
  mockListMonthlyFacts: vi.fn(),
}));

vi.mock("@/lib/finance-monthly-fact-store", () => ({
  listMonthlyFacts: mockListMonthlyFacts,
}));

import {
  buildFinanceMonthlyBalanceSeries,
  FINANCE_CURRENT_ASSET_ACCOUNT_TYPES,
  FINANCE_CURRENT_LIABILITY_ACCOUNT_TYPES,
} from "@/lib/finance-monthly-balance";

function balanceFact(seed: {
  month: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountClass: string;
  amountCents: number;
  isProvisional?: boolean;
}) {
  return {
    statementKind: "BALANCE_SHEET",
    month: seed.month,
    accountCode: seed.accountCode,
    accountId: `acc-${seed.accountCode}`,
    accountName: seed.accountName,
    accountType: seed.accountType,
    accountClass: seed.accountClass,
    amountCents: seed.amountCents,
    currency: "NZD",
    isProvisional: seed.isProvisional ?? false,
    sourceReport: "getReportBalanceSheet",
    syncedAt: new Date("2026-07-06T10:15:00.000Z"),
  };
}

function monthFacts(month: string, scale = 1, provisional = false) {
  return [
    balanceFact({ month, accountCode: "090", accountName: "Cheque", accountType: "BANK", accountClass: "ASSET", amountCents: 150_000 * scale, isProvisional: provisional }),
    balanceFact({ month, accountCode: "091", accountName: "Savings", accountType: "BANK", accountClass: "ASSET", amountCents: 50_000 * scale, isProvisional: provisional }),
    balanceFact({ month, accountCode: "630", accountName: "Prepayments", accountType: "PREPAYMENT", accountClass: "ASSET", amountCents: 10_000 * scale, isProvisional: provisional }),
    balanceFact({ month, accountCode: "710", accountName: "Lodge", accountType: "FIXED", accountClass: "ASSET", amountCents: 900_000 * scale, isProvisional: provisional }),
    balanceFact({ month, accountCode: "800", accountName: "Accounts Payable", accountType: "CURRLIAB", accountClass: "LIABILITY", amountCents: 40_000 * scale, isProvisional: provisional }),
    balanceFact({ month, accountCode: "900", accountName: "Loan", accountType: "TERMLIAB", accountClass: "LIABILITY", amountCents: 200_000 * scale, isProvisional: provisional }),
    balanceFact({ month, accountCode: "970", accountName: "Retained Earnings", accountType: "EQUITY", accountClass: "EQUITY", amountCents: 870_000 * scale, isProvisional: provisional }),
  ];
}

describe("buildFinanceMonthlyBalanceSeries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("totals classes per month and buckets current vs non-current by account type", async () => {
    mockListMonthlyFacts.mockResolvedValue([
      ...monthFacts("2026-05"),
      ...monthFacts("2026-06", 2, true),
    ]);

    const series = await buildFinanceMonthlyBalanceSeries({
      fromMonth: "2026-04",
      toMonth: "2026-06",
    }, CLUB_FORMAT_TEST);

    expect(series.points).toHaveLength(3);
    const [april, may, june] = series.points;

    expect(april).toMatchObject({ monthKey: "2026-04", hasData: false });

    expect(may).toMatchObject({
      monthKey: "2026-05",
      label: "May 2026",
      assetsCents: 1_110_000,
      liabilitiesCents: 240_000,
      netAssetsCents: 870_000,
      currentAssetsCents: 210_000, // bank + prepayment; FIXED excluded
      currentLiabilitiesCents: 40_000, // CURRLIAB only; TERMLIAB excluded
      workingCapitalCents: 170_000,
      bankCents: 200_000,
      hasData: true,
      isProvisional: false,
    });

    expect(june).toMatchObject({
      monthKey: "2026-06",
      assetsCents: 2_220_000,
      isProvisional: true,
    });

    expect(series.latest?.monthKey).toBe("2026-06");
    expect(series.monthsWithData).toBe(2);
    expect(series.latestBankAccounts).toEqual([
      { label: "Cheque", balanceCents: 300_000 },
      { label: "Savings", balanceCents: 100_000 },
    ]);
  });

  it("returns an empty series when no rows are stored", async () => {
    mockListMonthlyFacts.mockResolvedValue([]);

    const series = await buildFinanceMonthlyBalanceSeries({
      fromMonth: "2026-05",
      toMonth: "2026-06",
    }, CLUB_FORMAT_TEST);

    expect(series.latest).toBeNull();
    expect(series.monthsWithData).toBe(0);
    expect(series.latestBankAccounts).toEqual([]);
    expect(series.points.every((point) => !point.hasData)).toBe(true);
  });

  it("documents the current-account-type buckets", () => {
    expect(FINANCE_CURRENT_ASSET_ACCOUNT_TYPES.has("BANK")).toBe(true);
    expect(FINANCE_CURRENT_ASSET_ACCOUNT_TYPES.has("FIXED")).toBe(false);
    expect(FINANCE_CURRENT_LIABILITY_ACCOUNT_TYPES.has("CURRLIAB")).toBe(true);
    expect(FINANCE_CURRENT_LIABILITY_ACCOUNT_TYPES.has("TERMLIAB")).toBe(false);
  });
});
