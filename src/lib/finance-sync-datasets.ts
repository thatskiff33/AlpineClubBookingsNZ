import type { FinanceSyncDatasetDefinition } from "@/lib/finance-sync-service";
import {
  FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
  FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
  FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
  FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
  syncFinanceAgedReceivablesSnapshot,
  syncFinanceBalanceSheetSnapshot,
  syncFinanceBankBalancesSnapshot,
  syncFinanceProfitAndLossMonthlySnapshot,
} from "@/lib/finance-sync-xero-datasets";

const financeSyncDatasets: FinanceSyncDatasetDefinition[] = [
  {
    key: FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
    description: "Xero monthly profit and loss report snapshot",
    sync: syncFinanceProfitAndLossMonthlySnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
    description: "Xero balance sheet report snapshot",
    sync: syncFinanceBalanceSheetSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
    description: "Xero bank summary report snapshot",
    sync: syncFinanceBankBalancesSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
    description: "Xero aged receivables snapshot from open receivable invoices",
    sync: syncFinanceAgedReceivablesSnapshot,
  },
];

export function getFinanceSyncDatasets(): FinanceSyncDatasetDefinition[] {
  return financeSyncDatasets.slice();
}
