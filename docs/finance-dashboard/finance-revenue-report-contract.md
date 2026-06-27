# Finance Revenue Report Contract

Superseded: the `/finance/revenue` page route has been removed. Revenue metrics
now appear as the Revenue view on the selector-driven `/finance` dashboard. Keep
this document only as historical calculation background.

This document defines the native `/finance/revenue` report page.

It is intentionally small. The page turns the landed `PROFIT_AND_LOSS_MONTHLY` finance snapshot storage into a native monthly revenue report, but it does not add charts, balance-sheet views, cash reporting, or live Xero read paths.

## Boundary

- `src/app/(finance)/finance/revenue/page.tsx` renders the native revenue report page.
- `src/lib/finance-revenue-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-sync-storage.ts` provides the finance snapshot read helper used by the report page.

## Access

- finance viewers and finance managers can load `/finance/revenue`
- the page stays under the existing finance route group and finance viewer guard
- manager-only sync diagnostics remain separate from the page content

## Default Period Selection

The page defaults to the latest `6` stored monthly profit-and-loss snapshots from the finance snapshot store.

The page may accept a query-string override:

- `periods`

`periods` must be a whole number between `1` and `24`.

Invalid values must fall back safely to the default `6`-period view instead of breaking the page.

## Data Source and Ownership

The page must keep source ownership explicit:

- revenue figures come from stored `FinanceSnapshot` rows with `snapshotType = PROFIT_AND_LOSS_MONTHLY`
- those snapshots are synced through the single operational Xero connection
- the page does not use AlpineClubBookingsNZ booking metrics or payment rows for its revenue totals
- the page does not trigger live Xero reads or manual sync mutations while rendering

## Page Content

The page renders:

- revenue summary cards for the selected stored periods
- a monthly detail table across the selected stored snapshots
- a revenue line-item table grouped by the stored profit-and-loss labels
- source notes that explain the finance snapshot boundary

## Failure Handling

- if no monthly profit-and-loss snapshots exist yet, the page shows a safe unavailable state
- if stored snapshot payloads cannot be parsed, malformed periods are skipped and the page continues with any remaining valid periods
- if the finance snapshot read path fails, the page shows a safe unavailable state without exposing raw infrastructure errors to finance viewers

## Explicit Non-goals

This report page does not implement:

- charts
- booking-derived revenue or occupancy figures
- costs, cash, or balance-sheet report pages
- manual sync actions
- operational Xero connection work
