# Finance Working-Capital Report Contract

Superseded: the `/finance/working-capital` page route has been removed. Working
capital metrics now appear as the Working Capital view on the selector-driven
`/finance` dashboard. Keep this document only as historical calculation
background.

This document defines the native `/finance/working-capital` report page.

## Surface Area

- `src/app/(finance)/finance/working-capital/page.tsx` renders the native working-capital report page.
- `src/lib/finance-working-capital-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-balance-sheet-report-page.ts` provides the narrow stored balance-sheet snapshot parser reused by the working-capital page.
- `src/lib/finance-sync-storage.ts` provides the finance snapshot read helper used by the report page.

## Access and Routing Contract

- finance viewers and finance managers can load `/finance/working-capital`
- unauthorized users follow the existing finance access redirect and gating behavior from `src/lib/finance-auth.ts`

## Data Source Contract

- all figures on the page come from stored `BALANCE_SHEET` `FinanceSnapshot` rows
- current assets are derived only from stored balance-sheet sections explicitly labelled as current assets
- current liabilities are derived only from stored balance-sheet sections explicitly labelled as current liabilities
- working-capital figures stay explicitly finance-snapshot-backed and distinct from AlpineClubBookingsNZ booking metrics, payment-derived cash summaries, and the separate native cash report
- the page reads durable stored snapshots only; it does not trigger live Xero report reads, manual sync mutations, or liquidity forecasts

## Report Behavior Contract

- the page defaults to the latest 6 stored balance-sheet snapshots and supports a validated `periods` query filter
- invalid `periods` values fail closed to the default window with viewer-safe warning copy
- working capital is `currentAssetsCents - currentLiabilitiesCents` for each selected stored snapshot
- current ratio is `currentAssetsCents / currentLiabilitiesCents` only when current liabilities are greater than zero; otherwise the ratio is withheld as unavailable
- if no stored balance-sheet snapshots exist, the page renders a safe unavailable state instead of raw loader errors
- if some stored balance-sheet snapshots are malformed, parsable snapshots still render and the skipped rows are reported through viewer-safe warnings
- if a stored balance-sheet snapshot lacks either a current-assets or current-liabilities section, that snapshot is skipped with viewer-safe warning copy instead of inferring totals from broader assets or liabilities sections
- the page renders:
  - summary cards for the latest stored current assets, current liabilities, working capital, and current-assets coverage ratio
  - a period comparison table for the selected stored balance-sheet snapshots

## Explicit Non-goals

This report page does not implement:

- cashflow forecasting or runway calculations
- charts or stakeholder-facing visualisations
- manual sync actions
- operational Xero connection work
- undocumented legacy-dashboard formulas beyond the explicit assumptions above

## Validation Contract

- targeted loader coverage lives in `src/lib/__tests__/finance-working-capital-report-page.test.ts`
- runtime validation should include `npm run build` because the feature adds a new finance route
