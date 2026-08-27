/**
 * Fact-table balance-sheet series for the finance dashboard.
 *
 * Reads BALANCE_SHEET rows from FinanceAccountMonthlyBalance (closing
 * month-end positions per GL account) and produces per-month totals for the
 * cash, balance-sheet, and working-capital views. Xero's account `class`
 * (ASSET/LIABILITY/EQUITY) drives the headline totals; the account `type`
 * distinguishes current from non-current and bank accounts, since class does
 * not carry that information.
 */

import { FinanceMonthlyStatementKind } from "@prisma/client";
import {
  financeDashboardWindowMonths,
  type FinanceDashboardDateWindow,
} from "@/lib/finance-dashboard-ranges";
import { financeDashboardTrendMonthLabel } from "@/lib/finance-dashboard-labels";
import {
  listMonthlyFacts,
  type FinanceMonthlyFactRecord,
} from "@/lib/finance-monthly-fact-store";

/**
 * Xero account types treated as current for working capital. Documented
 * bucket mapping — adjust here (with tests) if the org's chart uses types
 * differently.
 */
export const FINANCE_CURRENT_ASSET_ACCOUNT_TYPES = new Set([
  "BANK",
  "CURRENT",
  "INVENTORY",
  "PREPAYMENT",
]);

export const FINANCE_CURRENT_LIABILITY_ACCOUNT_TYPES = new Set([
  "CURRLIAB",
  "PAYGLIABILITY",
  "SUPERANNUATIONLIABILITY",
]);

interface FinanceMonthlyBalancePoint {
  monthKey: string;
  /** Short month label for chart axes, e.g. "Jun 2026". */
  label: string;
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  netAssetsCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  workingCapitalCents: number;
  bankCents: number;
  hasData: boolean;
  isProvisional: boolean;
}

export interface FinanceMonthlyBalanceSeries {
  points: FinanceMonthlyBalancePoint[];
  /** Most recent month in the window with stored rows, or null. */
  latest: FinanceMonthlyBalancePoint | null;
  /** Latest month's bank accounts, largest balance first (cash mix). */
  latestBankAccounts: Array<{ label: string; balanceCents: number }>;
  monthsWithData: number;
}

function normalizedType(record: FinanceMonthlyFactRecord): string {
  return record.accountType?.toUpperCase() ?? "";
}

function normalizedClass(record: FinanceMonthlyFactRecord): string {
  return record.accountClass?.toUpperCase() ?? "";
}

export async function buildFinanceMonthlyBalanceSeries(
  window: Pick<FinanceDashboardDateWindow, "fromMonth" | "toMonth">,
  input?: { currentMonth?: string }
): Promise<FinanceMonthlyBalanceSeries> {
  const facts = await listMonthlyFacts({
    statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
    fromMonth: window.fromMonth,
    toMonth: window.toMonth,
  });

  const byMonth = new Map<string, FinanceMonthlyFactRecord[]>();
  for (const record of facts) {
    const rows = byMonth.get(record.month);
    if (rows) {
      rows.push(record);
    } else {
      byMonth.set(record.month, [record]);
    }
  }

  const points: FinanceMonthlyBalancePoint[] = financeDashboardWindowMonths(
    window
  ).map((monthKey) => {
    const rows = byMonth.get(monthKey) ?? [];
    let assetsCents = 0;
    let liabilitiesCents = 0;
    let equityCents = 0;
    let currentAssetsCents = 0;
    let currentLiabilitiesCents = 0;
    let bankCents = 0;
    let isProvisional = false;

    for (const record of rows) {
      const accountClass = normalizedClass(record);
      const accountType = normalizedType(record);
      isProvisional ||= record.isProvisional;

      if (accountClass === "ASSET") {
        assetsCents += record.amountCents;
        if (FINANCE_CURRENT_ASSET_ACCOUNT_TYPES.has(accountType)) {
          currentAssetsCents += record.amountCents;
        }
        if (accountType === "BANK") {
          bankCents += record.amountCents;
        }
      } else if (accountClass === "LIABILITY") {
        liabilitiesCents += record.amountCents;
        if (FINANCE_CURRENT_LIABILITY_ACCOUNT_TYPES.has(accountType)) {
          currentLiabilitiesCents += record.amountCents;
        }
      } else if (accountClass === "EQUITY") {
        equityCents += record.amountCents;
      }
    }

    return {
      monthKey,
      label: financeDashboardTrendMonthLabel(monthKey),
      assetsCents,
      liabilitiesCents,
      equityCents,
      netAssetsCents: assetsCents - liabilitiesCents,
      currentAssetsCents,
      currentLiabilitiesCents,
      workingCapitalCents: currentAssetsCents - currentLiabilitiesCents,
      bankCents,
      hasData: rows.length > 0,
      isProvisional,
    };
  });

  const withData = points.filter((point) => point.hasData);
  const latest = withData.at(-1) ?? null;
  const latestBankAccounts = latest
    ? (byMonth.get(latest.monthKey) ?? [])
        .filter(
          (record) =>
            normalizedClass(record) === "ASSET" &&
            normalizedType(record) === "BANK"
        )
        .map((record) => ({
          label: record.accountName ?? record.accountCode,
          balanceCents: record.amountCents,
        }))
        .sort((left, right) => right.balanceCents - left.balanceCents)
    : [];

  return {
    points,
    latest,
    latestBankAccounts,
    monthsWithData: withData.length,
  };
}
