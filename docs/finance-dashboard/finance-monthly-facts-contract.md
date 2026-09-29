# Finance Monthly Facts Contract

This document defines the monthly per-account fact table
(`FinanceAccountMonthlyBalance`) that the finance dashboard reads for revenue,
costs, cash, and balance-sheet reporting, and the sync/backfill boundary that
populates it from Xero.

## Why this table exists

The original dashboard aggregation read the daily `PROFIT_AND_LOSS_MONTHLY`
snapshots, which are cumulative month-to-date captures (one per daily sync).
Summing every snapshot that overlapped a selected range multi-counted amounts
(issue #15's inflated revenue figure) and produced per-snapshot trend points
labelled with Xero report titles (issue #16). The fact table stores the
corrected shape: one discrete amount per statement kind, month, and Xero GL
account code.

## Data shape

One row per `(statementKind, scope, month, accountCode)`:

- `statementKind`: `PROFIT_AND_LOSS` rows hold the month's **net activity**
  for a revenue/expense account. `BALANCE_SHEET` rows hold the **closing
  month-end position** for an asset/liability/equity account.
- `month`: always the first day of the month, NZ date-only.
- `accountCode`: normalized upper-case Xero GL code. It joins directly to
  `FinanceReportCategoryMapping.accountCode`, so category views (Hut Fees,
  Catering, …) are a straight join.
- `accountId`/`accountName`/`accountType`/`accountClass`: metadata resolved
  from the chart-of-accounts snapshot at extraction time. `accountClass` is
  Xero's REVENUE/EXPENSE/ASSET/LIABILITY/EQUITY; `accountType` (BANK,
  CURRLIAB, …) is what distinguishes current from non-current and bank
  accounts.
- `amountCents`: integer cents, stored with Xero's reporting sign convention
  (revenue and expenses both positive in their sections). Netting is a reader
  concern.
- `isProvisional`: true while the month was still in progress when pulled
  (amounts are month-to-date). The first sync after month end overwrites the
  row with the completed figure and clears the flag.
- `syncRunId`/`sourceReport`/`syncedAt`: provenance.

## How rows are produced

`src/lib/finance-monthly-facts.ts` (pure) extracts rows from a stored
multi-period Xero report payload:

- Column-to-month mapping parses the report header's date cells; Xero returns
  columns newest-first and nothing assumes an order.
- Only leaf rows carrying an `account` cell attribute are read, so summary and
  total rows are structurally excluded.
- AccountIDs resolve through the latest `CHART_OF_ACCOUNTS` snapshot
  (`loadFinanceMonthlyChartContext` in `finance-monthly-fact-store.ts`). Rows
  with amounts that cannot resolve to a GL code are reported as
  `unresolvedRowLabels`; the dataset handler fails the pull rather than storing
  a partial set (see Failure behaviour).
- The extraction also reports `periodColumnCount` (the header's non-label data
  cells) so the dataset handler can detect a period header that only partially
  parsed.

`src/lib/finance-monthly-fact-store.ts` persists rows with whole-window
replacement: a pull covering months M1..Mn atomically deletes and recreates
those months (per statement kind and scope). Re-runs are idempotent, and
accounts zeroed out by late Xero edits disappear instead of going stale.
Months outside the pulled window are never touched.

## Sync integration

Two datasets in the daily finance sync (`src/lib/finance-sync-datasets.ts`),
registered after the chart-of-accounts dataset so the chart snapshot is
same-run fresh:

- `xero-profit-and-loss-by-month`: one `getReportProfitAndLoss` call with
  `periods=11, timeframe=MONTH, standardLayout=true` → 12 monthly columns.
- `xero-balance-sheet-by-month`: one `getReportBalanceSheet` call with the
  same window → 12 month-end positions.

The raw multi-period reports are retained as `PROFIT_AND_LOSS_BY_MONTH` /
`BALANCE_SHEET_BY_MONTH` snapshots keyed on the window end month (daily
re-pulls overwrite one snapshot per month), so fact rows can be re-derived
without a Xero call.

Because every daily run re-pulls a rolling 12-month window, late accountant
edits up to a year back self-heal automatically. Older adjustments require a
backfill re-run.

Dataset handlers attach fact rows to their snapshot via the optional
`monthlyFacts` field on `FinanceSyncSnapshotInput`; `runFinanceSync` persists
the snapshot, then replaces the covered fact months, and records
`factRowCount`/`unresolvedFactRowCount` per dataset in the run summary.

Failure behaviour is deliberately loud, so no pull silently replaces stored
months with an incomplete set. The dataset handler throws — leaving the stored
months untouched and marking only that dataset failed — when a report has:

- an unparseable period header (no date columns parse), or a header whose date
  cells only **partially** parse (fewer months than `periodColumnCount`), which
  would otherwise drop the unparsed months from both the rows and the replace
  window and leave them stale;
- a missing chart-of-accounts snapshot; or
- **any** leaf row that carries an amount but does not resolve to a GL code
  (not just the all-unresolved case) — a resolved subset would otherwise
  replace the whole window and drop the unresolved account's amounts. The chart
  dataset is pulled fresh earlier in the same run, so an unresolved row means a
  genuinely new/absent account; rerun after the chart snapshot catches up.

## Historical backfill

`src/lib/finance-monthly-fact-backfill.ts` walks backwards from the current
month in 12-month chunks (2 Xero calls per chunk-year). The **unbounded** walk
(no `fromMonth`) stops at organisation pre-history — the first chunk with no
non-zero amounts. When an explicit `fromMonth` is given, the walk instead runs
to the chunk containing that month and **ignores dormant chunks along the way**,
so a quiet year mid-history cannot block older data the operator asked for. It
runs through `runFinanceSync` under the `finance-monthly-fact-backfill`
workflow with trigger `BACKFILL`.

Operator entry points:

- `POST /api/finance/sync/backfill-monthly-facts` (finance manager access;
  409 when any finance sync run is in progress; body accepts optional
  `fromMonth` "YYYY-MM" and `maxChunks`).
- `pnpm run finance:backfill-monthly-facts [--from-month 2020-04]
  [--max-chunks 5]`.

Run the backfill against the Xero demo tenant before production, per the
repository safety rules.

## Reader contract

Dashboard readers use `listMonthlyFacts({ statementKind, fromMonth, toMonth })`
and must:

- treat month keys ("YYYY-MM") as the range boundary — the dashboard is
  month-granular by design; day-level detail lives in Xero;
- exclude or clearly flag `isProvisional` months in totals and trends;
- join `accountCode` to `FinanceReportCategoryMapping` for category grouping
  and treat unmatched codes as unmapped rather than dropping them.
