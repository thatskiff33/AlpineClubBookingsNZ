# Finance Cash Report Contract

Superseded: the `/finance/cash` page route has been removed. Cash metrics now
appear as the Cash view on the selector-driven `/finance` dashboard. Keep this
document only as historical calculation background.

This document defines the native `/finance/cash` report page.

It is intentionally small. The page turns the landed `BANK_BALANCES` finance snapshot storage into a native cash balances report, but it does not add working-capital rollups, balance-sheet views, costs reporting, or live Xero read paths.

## Boundary

- `src/app/(finance)/finance/cash/page.tsx` renders the native cash report page.
- `src/lib/finance-cash-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-sync-storage.ts` provides the finance snapshot read helper used by the report page.

## Access

- finance viewers and finance managers can load `/finance/cash`
- the page stays under the existing finance route group and finance viewer guard
- manager-only sync diagnostics remain separate from the page content

## Default Period Selection

The page defaults to the latest `7` stored bank-balance snapshots from the finance snapshot store.

The page may accept a query-string override:

- `periods`

`periods` must be a whole number between `1` and `31`.

Invalid values must fall back safely to the default `7`-period view instead of breaking the page.

## Data Source and Ownership

The page must keep source ownership explicit:

- cash figures come from stored `FinanceSnapshot` rows with `snapshotType = BANK_BALANCES`
- those snapshots are synced through the single operational Xero connection
- the page does not use AlpineClubBookingsNZ payment rows for its cash totals
- the page does not trigger live Xero reads or manual sync mutations while rendering

## Page Content

The page renders:

- cash summary cards for the selected stored snapshots
- a snapshot detail table across the selected stored bank-balance snapshots
- a bank-account comparison table grouped by the stored bank summary labels
- source notes that explain the finance snapshot boundary

## Failure Handling

- if no bank-balance snapshots exist yet, the page shows a safe unavailable state
- if stored snapshot payloads cannot be parsed, malformed snapshots are skipped and the page continues with any remaining valid snapshots
- if the finance snapshot read path fails, the page shows a safe unavailable state without exposing raw infrastructure errors to finance viewers

## Explicit Non-goals

This report page does not implement:

- working-capital rollups
- costs or balance-sheet report pages
- AlpineClubBookingsNZ payment-derived cash summaries
- charts
- manual sync actions
- operational Xero connection work
