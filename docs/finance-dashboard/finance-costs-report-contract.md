# Finance Costs Report Contract

Superseded: the `/finance/costs` page route has been removed. Costs metrics now
appear as the Costs view on the selector-driven `/finance` dashboard. Keep this
document only as historical calculation background.

This document defines the native `/finance/costs` report page.

## Surface Area

- `src/app/(finance)/finance/costs/page.tsx` renders the native costs report page.
- `src/lib/finance-costs-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-sync-storage.ts` provides the finance snapshot read helper used by the report page.

## Access and Routing Contract

- finance viewers and finance managers can load `/finance/costs`
- unauthorized users follow the existing finance access redirect and gating behavior from `src/lib/finance-auth.ts`

## Data Source Contract

- all figures on the page come from stored `PROFIT_AND_LOSS_MONTHLY` `FinanceSnapshot` rows
- costs remain explicitly finance-snapshot-backed and distinct from AlpineClubBookingsNZ booking metrics, payment-derived cash summaries, and the separate native cash and balance-sheet report totals
- the page reads durable stored snapshots only; it does not trigger live Xero report reads, manual sync mutations, pricing-sensitivity analysis, or working-capital calculations

## Report Behavior Contract

- the page defaults to the latest 6 stored monthly profit-and-loss snapshots and supports a validated `periods` query filter
- invalid `periods` values fail closed to the default window with viewer-safe warning copy
- if no stored monthly profit-and-loss snapshots exist, the page renders a safe unavailable state instead of raw loader errors
- if some stored profit-and-loss snapshots are malformed, parsable snapshots still render and the skipped rows are reported through viewer-safe warnings
- the page renders:
  - summary cards for the latest stored costs, selected-period totals, average monthly costs, and tracked cost lines
  - a monthly snapshot table for the selected stored periods
  - a grouped cost line-item table for the selected stored periods

## Validation Contract

- targeted loader coverage lives in `src/lib/__tests__/finance-costs-report-page.test.ts`
- runtime validation should include `npm run build` because the feature adds a new finance route
