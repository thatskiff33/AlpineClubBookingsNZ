/**
 * Historical backfill of the FinanceAccountMonthlyBalance fact table.
 *
 * Walks backwards from the current month in 12-month chunks, pulling the same
 * multi-period Xero reports the daily sync uses (one profit-and-loss and one
 * balance-sheet call per chunk-year). The unbounded walk stops at organisation
 * pre-history (the first chunk with no non-zero amounts); an explicit fromMonth
 * bound instead walks the whole requested window, ignoring dormant chunks so a
 * quiet year mid-history cannot block older data. Chunks replace their own
 * months idempotently, so the backfill can be re-run at any time — including to
 * pick up late Xero edits older than the daily sync's rolling 12-month window.
 *
 * Runs through runFinanceSync so every backfill gets the same run tracking,
 * snapshot provenance and failure handling as the daily sync. All Xero calls
 * happen inside the dataset step; database writes follow afterwards, keeping
 * provider calls out of database transactions.
 */

import { FinanceSyncRunTrigger, Prisma } from "@prisma/client";
import { shiftMonthKey, isMonthKey } from "@/lib/finance-monthly-facts";
import { loadFinanceMonthlyChartContext } from "@/lib/finance-monthly-fact-store";
import {
  fetchFinanceBalanceSheetByMonthSnapshot,
  fetchFinanceProfitAndLossByMonthSnapshot,
  getFinanceMonthKeyForDate,
  syncFinanceChartOfAccountsSnapshot,
  FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY,
  type FinanceMonthlyFactsWindowInput,
} from "@/lib/finance-sync-xero-datasets";
import {
  runFinanceSync,
  type FinanceSyncDatasetContext,
  type FinanceSyncDatasetDefinition,
  type FinanceSyncExecutionResult,
  type FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";

export const FINANCE_MONTHLY_FACT_BACKFILL_WORKFLOW =
  "finance-monthly-fact-backfill";
const FINANCE_SYNC_XERO_PROFIT_AND_LOSS_BY_MONTH_BACKFILL_DATASET_KEY =
  "xero-profit-and-loss-by-month-backfill";
const FINANCE_SYNC_XERO_BALANCE_SHEET_BY_MONTH_BACKFILL_DATASET_KEY =
  "xero-balance-sheet-by-month-backfill";

/**
 * Upper bound on 12-month chunks walked per report (30 years). A runaway
 * backstop only — real runs stop at organisation pre-history first.
 */
export const DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS = 30;

export interface BackfillFinanceMonthlyFactsInput {
  requestedByMemberId?: string | null;
  /**
   * Optional inclusive lower bound ("YYYY-MM"). The walk runs until the chunk
   * containing this month — dormant chunks along the way do not stop it, so a
   * quiet year cannot block older history; chunk granularity means up to 11
   * earlier months may still be pulled. Omit to backfill the full org history
   * (which does stop at the first dormant chunk / pre-history).
   */
  fromMonth?: string | null;
  maxChunks?: number;
  metadata?: Prisma.InputJsonObject;
}

interface BackfillChunkOptions {
  fromMonth: string | null;
  maxChunks: number;
}

function assertBackfillInput(input: BackfillFinanceMonthlyFactsInput): void {
  if (input.fromMonth && !isMonthKey(input.fromMonth)) {
    throw new Error(
      `fromMonth must be a YYYY-MM month key, got "${input.fromMonth}"`
    );
  }
  if (
    input.maxChunks !== undefined &&
    (!Number.isInteger(input.maxChunks) || input.maxChunks < 1)
  ) {
    throw new Error("maxChunks must be a positive integer");
  }
}

function chunkHasActivity(snapshot: FinanceSyncSnapshotInput): boolean {
  return (
    snapshot.monthlyFacts?.rows.some((row) => row.amountCents !== 0) ?? false
  );
}

async function backfillReportChunks(
  context: FinanceSyncDatasetContext,
  fetchSnapshot: (
    context: FinanceSyncDatasetContext,
    window: FinanceMonthlyFactsWindowInput
  ) => Promise<FinanceSyncSnapshotInput>,
  options: BackfillChunkOptions
): Promise<FinanceSyncSnapshotInput[]> {
  // Loaded once per report walk; the chart-of-accounts dataset in this run
  // has already persisted a fresh snapshot by the time this executes.
  const chart = await loadFinanceMonthlyChartContext();
  const currentMonth = getFinanceMonthKeyForDate(context.startedAt, context.clubTimeZone);
  const snapshots: FinanceSyncSnapshotInput[] = [];

  let endMonth = currentMonth;
  for (let chunk = 0; chunk < options.maxChunks; chunk += 1) {
    const snapshot = await fetchSnapshot(context, {
      endMonth,
      currentMonth,
      chart,
    });
    snapshots.push(snapshot);

    const months = snapshot.monthlyFacts?.months ?? [];
    const oldestMonth = months[0];
    if (!oldestMonth) {
      break;
    }
    if (options.fromMonth && oldestMonth <= options.fromMonth) {
      break;
    }
    if (!options.fromMonth && !chunkHasActivity(snapshot)) {
      // Organisation pre-history: a whole year with no non-zero amounts. Only
      // the unbounded walk stops here — an explicit fromMonth means the
      // operator wants that whole window, so a dormant year mid-history must
      // not cut the walk short before reaching the requested bound.
      break;
    }

    endMonth = shiftMonthKey(oldestMonth, -1);
  }

  return snapshots;
}

export function buildFinanceMonthlyFactBackfillDatasets(
  options: BackfillChunkOptions
): FinanceSyncDatasetDefinition[] {
  return [
    {
      key: FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY,
      description:
        "Fresh chart-of-accounts snapshot so historical report rows resolve to GL codes",
      sync: syncFinanceChartOfAccountsSnapshot,
    },
    {
      key: FINANCE_SYNC_XERO_PROFIT_AND_LOSS_BY_MONTH_BACKFILL_DATASET_KEY,
      description:
        "Historical monthly per-account profit-and-loss facts (12-month chunks)",
      sync: (context) =>
        backfillReportChunks(
          context,
          fetchFinanceProfitAndLossByMonthSnapshot,
          options
        ),
    },
    {
      key: FINANCE_SYNC_XERO_BALANCE_SHEET_BY_MONTH_BACKFILL_DATASET_KEY,
      description:
        "Historical monthly per-account balance-sheet positions (12-month chunks)",
      sync: (context) =>
        backfillReportChunks(
          context,
          fetchFinanceBalanceSheetByMonthSnapshot,
          options
        ),
    },
  ];
}

export async function backfillFinanceMonthlyFacts(
  input: BackfillFinanceMonthlyFactsInput = {}
): Promise<FinanceSyncExecutionResult> {
  assertBackfillInput(input);

  const fromMonth = input.fromMonth ?? null;
  const maxChunks = input.maxChunks ?? DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS;

  return runFinanceSync({
    workflow: FINANCE_MONTHLY_FACT_BACKFILL_WORKFLOW,
    trigger: FinanceSyncRunTrigger.BACKFILL,
    requestedByMemberId: input.requestedByMemberId ?? null,
    datasets: buildFinanceMonthlyFactBackfillDatasets({ fromMonth, maxChunks }),
    metadata: {
      source: "finance-monthly-fact-backfill",
      fromMonth,
      maxChunks,
      ...(input.metadata ?? {}),
    },
  });
}
