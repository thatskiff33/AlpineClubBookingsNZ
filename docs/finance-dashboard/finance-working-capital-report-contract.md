# Finance Working-Capital Report Contract

This document defines the native `/finance/working-capital` report page added for task `#153` under phase `#99`.

## Surface Area

- `src/app/(finance)/finance/working-capital/page.tsx` renders the native working-capital report page.
- `src/lib/finance-working-capital-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-balance-sheet-report-page.ts` provides the reusable stored balance-sheet parsing helper used by the report page.
- `src/lib/finance-sync-storage.ts` provides the finance-only snapshot read helper used by the report page.

## Access and Routing Contract

- finance viewers and finance managers can load `/finance/working-capital`
- unauthorized users follow the existing finance access redirect and gating behavior from `src/lib/finance-auth.ts`

## Data Source Contract

- all figures on the page come from stored `BALANCE_SHEET` `FinanceSnapshot` rows
- current assets, current liabilities, working capital, and current ratio stay explicitly balance-sheet-snapshot-backed and distinct from TACBookings booking metrics, payment-derived cash summaries, and the separate native cash report
- the page reads durable stored snapshots only; it does not trigger live Xero report reads, manual sync mutations, liquidity forecasting, or legacy-dashboard-only calculations

## Working-Capital Contract

- the page defaults to the latest `6` stored balance-sheet snapshots and supports a validated `periods` query filter
- invalid `periods` values fail closed to the default window with viewer-safe warning copy
- current assets are derived from the stored balance-sheet section whose label includes `Current Assets`
- current liabilities are derived from the stored balance-sheet section whose label includes `Current Liabilities`
- when a current-assets or current-liabilities section includes a matching summary row, the page uses that total; otherwise it sums the stored detail rows inside that section
- working capital is `currentAssets - currentLiabilities`
- current ratio is `currentAssets / currentLiabilities` and is shown as unavailable when the stored snapshot records zero current liabilities
- the page renders:
  - summary cards for the latest stored current assets, current liabilities, working capital, and current ratio
  - a period comparison table for the selected stored working-capital snapshots

## Failure Handling Contract

- if no stored balance-sheet snapshots exist, the page shows a safe unavailable state
- if stored balance-sheet snapshots cannot be parsed, malformed snapshots are skipped and the page continues with any remaining valid snapshots
- if a parsed balance-sheet snapshot does not expose both current-assets and current-liabilities sections, that snapshot is skipped with viewer-safe warning copy
- if no comparable working-capital snapshots remain after parsing, the page shows a safe unavailable state without exposing raw infrastructure errors

## Explicit Non-goals

This report page does not implement:

- liquidity forecasting or runway calculations
- charts or stakeholder-facing visualisations
- manual sync actions
- finance Xero connection work
- booking-metrics rollups beyond the explicit source-boundary note
- hidden legacy-dashboard formulas beyond the explicit assumptions above

## Validation Contract

- targeted loader coverage lives in `src/lib/__tests__/finance-working-capital-report-page.test.ts`
- runtime validation should include `npm run build` because the feature adds a new finance route
