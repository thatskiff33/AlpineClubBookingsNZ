# Finance Pricing Sensitivity Report Contract

Superseded: the `/finance/pricing-sensitivity` page route has been removed.
Pricing sensitivity metrics now appear as the Pricing Sensitivity view on the
selector-driven `/finance` dashboard. Keep this document only as historical
calculation background.

This document defines the native `/finance/pricing-sensitivity` report page.

## Surface Area

- `src/app/(finance)/finance/pricing-sensitivity/page.tsx` renders the native pricing-sensitivity report page.
- `src/lib/finance-pricing-sensitivity-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-sync-storage.ts` provides the finance monthly cost snapshot read helper used by the report page.
- `src/lib/finance-booking-metrics.ts` provides the realized AlpineClubBookingsNZ booking metrics used to compare demand against the selected monthly cost periods.

## Access and Routing Contract

- finance viewers and finance managers can load `/finance/pricing-sensitivity`
- unauthorized users follow the existing finance access redirect and gating behavior from `src/lib/finance-auth.ts`

## Data Source Contract

- monthly costs come from stored `PROFIT_AND_LOSS_MONTHLY` `FinanceSnapshot` rows
- guest nights, occupancy, and booked revenue come from AlpineClubBookingsNZ realized booking metrics for the same monthly windows
- booked revenue remains explicitly AlpineClubBookingsNZ booking-derived and distinct from payment-derived cash totals
- the page reads durable stored data only; it does not trigger live Xero reads or manual sync mutations

## Pricing Sensitivity Contract

- the page defaults to the latest `6` stored monthly profit-and-loss snapshots and supports a validated `periods` query filter
- invalid `periods` values fail closed to the default window with viewer-safe warning copy
- the page matches each selected monthly cost snapshot to a realized booking-metrics window using the snapshot `periodStart` and the earlier of `periodEnd` or `asOfDate`
- actual revenue per guest night for a matched month is `bookedRevenueCents / guestNights`
- break-even revenue per guest night for a matched month is `totalCostsCents / guestNights`
- scenario rows use the selected periods' average monthly capacity bed nights and declared occupancy assumptions to derive:
  - implied guest nights per month
  - required average revenue per guest night
  - implied booked revenue at the selected periods' actual realized average revenue per guest night
  - booked revenue less costs at that implied demand level

## Failure Handling Contract

- if no stored monthly profit-and-loss snapshots exist, the page shows a safe unavailable state
- if stored monthly cost snapshots cannot be parsed, malformed snapshots are skipped and the page continues with any remaining valid snapshots
- if a matched realized booking-metrics month cannot be loaded, that month is skipped with viewer-safe warning copy
- if no comparable months remain after matching costs to realized booking metrics, the page shows a safe unavailable state without exposing raw infrastructure errors

## Explicit Non-goals

This report page does not implement:

- working-capital, cashflow, or liquidity rollups
- charts or stakeholder-facing visualisations
- manual sync actions
- operational Xero connection work
- booking-type segmentation or new pricing schema
- undocumented legacy-dashboard formulas beyond the explicit assumptions above

## Validation Contract

- targeted loader coverage lives in `src/lib/__tests__/finance-pricing-sensitivity-page.test.ts`
- runtime validation should include `npm run build` because the feature adds a new finance route
