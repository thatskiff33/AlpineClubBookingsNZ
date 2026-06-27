# Finance Balance-Sheet Report Contract

Superseded: the `/finance/balance-sheet` page route has been removed. Balance
sheet metrics now appear as the Balance Sheet view on the selector-driven
`/finance` dashboard. Keep this document only as historical calculation
background.

This document defines the native `/finance/balance-sheet` report page.

## Surface Area

- `src/app/(finance)/finance/balance-sheet/page.tsx` renders the native balance-sheet report page.
- `src/lib/finance-balance-sheet-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-sync-storage.ts` provides the finance snapshot read helper used by the report page.

## Access and Routing Contract

- finance viewers and finance managers can load `/finance/balance-sheet`
- unauthorized users follow the existing finance access redirect and gating behavior from `src/lib/finance-auth.ts`

## Data Source Contract

- all figures on the page come from stored `BALANCE_SHEET` `FinanceSnapshot` rows
- assets, liabilities, and net assets stay explicitly finance-snapshot-backed and distinct from AlpineClubBookingsNZ operational booking metrics, payment-derived cash summaries, and the separate native cash report
- the page reads durable stored snapshots only; it does not trigger live Xero report reads, manual sync mutations, costs rollups, or working-capital calculations

## Report Behavior Contract

- the page defaults to the latest 6 stored balance-sheet snapshots and supports a validated `periods` query filter
- invalid `periods` values fail closed to the default window with viewer-safe warning copy
- if no stored balance-sheet snapshots exist, the page renders a safe unavailable state instead of raw loader errors
- if some stored balance-sheet snapshots are malformed, parsable snapshots still render and the skipped rows are reported through viewer-safe warnings
- the page renders:
  - summary cards for the latest stored total assets, liabilities, and net assets
  - a snapshot table for the selected stored balance-sheet periods
  - a line-item detail table grouped by stored balance-sheet section labels

## Validation Contract

- targeted loader coverage lives in `src/lib/__tests__/finance-balance-sheet-report-page.test.ts`
- runtime validation should include `npm run build` because the feature adds a new finance route
