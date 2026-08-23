import { FinanceSnapshotType } from "@prisma/client";
import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";
import { callXeroApi } from "@/lib/xero";
import { getFinanceReportWindow } from "./date-format";
import {
  buildFinanceReportSnapshot,
  getRequiredReport,
  withFinanceReportScopeError,
} from "./report-snapshot";

export async function syncFinanceProfitAndLossMonthlySnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const response = await withFinanceReportScopeError(
    "getReportProfitAndLoss",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportProfitAndLoss(
            context.xeroTenantId,
            window.periodStartString,
            window.asOfDateString,
            1,
            "MONTH",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportProfitAndLoss",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets profitAndLossMonthly",
        }
      )
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
    asOfDate: window.asOfDate,
    periodStart: window.periodStart,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportProfitAndLoss"),
  });
}

export async function syncFinanceBalanceSheetSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const response = await withFinanceReportScopeError(
    "getReportBalanceSheet",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBalanceSheet(
            context.xeroTenantId,
            window.asOfDateString,
            1,
            "MONTH",
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportBalanceSheet",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets balanceSheet",
        }
      )
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.BALANCE_SHEET,
    asOfDate: window.asOfDate,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportBalanceSheet"),
  });
}

export async function syncFinanceBankBalancesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const response = await withFinanceReportScopeError(
    "getReportBankSummary",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBankSummary(
            context.xeroTenantId,
            window.periodStartString,
            window.asOfDateString
          ),
        {
          operation: "getReportBankSummary",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets bankBalances",
        }
      )
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
    asOfDate: window.asOfDate,
    periodStart: window.periodStart,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportBankSummary"),
  });
}
