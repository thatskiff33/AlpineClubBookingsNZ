# Finance Bookings Report Contract

Superseded: the `/finance/bookings` page route has been removed. Booking
metrics now appear as the Bookings view on the selector-driven `/finance`
dashboard. Keep this document only as historical calculation background.

This document defines the native `/finance/bookings` report page.

It is intentionally small. The page turns the landed AlpineClubBookingsNZ finance booking metrics boundary into a native bookings report with realized stay detail and forward pipeline detail, but it does not add charts, finance snapshot-backed revenue pages, or broader balance-sheet reporting.

## Boundary

- `src/app/(finance)/finance/bookings/page.tsx` renders the native bookings report page.
- `src/lib/finance-bookings-report-page.ts` is the loader and view-model boundary for the page.
- `src/lib/finance-booking-metrics.ts` remains the canonical finance query layer for AlpineClubBookingsNZ booking metrics.

## Access

- finance viewers and finance managers can load `/finance/bookings`
- the page stays under the existing finance route group and finance viewer guard
- the report exposes a viewer-safe link to the raw booking metrics JSON for the active report windows

## Default Windows

The page reuses the existing New Zealand local finance booking defaults:

- realized:
  - first day of the current NZ-local month
  - through the current NZ-local date inclusive
  - cutoff defaults to the realized end date
- forward:
  - next NZ-local date after today
  - through the next 90 NZ-local dates inclusive
  - `asOf` defaults to the current NZ-local date

The page may accept query-string overrides using the same names as the finance booking metrics route:

- `realizedFrom`
- `realizedTo`
- `realizedCutoff`
- `forwardFrom`
- `forwardTo`
- `forwardAsOf`

Invalid or incomplete page filters must fall back safely to the default report windows instead of breaking the page.

## Page Content

The page must keep source ownership explicit:

- booked revenue comes from AlpineClubBookingsNZ `Booking.finalPriceCents` allocated across stay nights
- net collected cash comes from AlpineClubBookingsNZ `Payment` rows
- the page does not show finance snapshot-backed or Xero-only revenue figures

The page renders:

- realized summary cards
- forward summary cards
- realized daily detail table
- realized status breakdown table
- forward daily detail table
- forward status breakdown table

## Failure Handling

- if booking metrics cannot be loaded, the page shows a safe unavailable state without exposing raw infrastructure error text to finance viewers
- invalid query-string filters show a warning and the page falls back to a safe default window

## Explicit Non-goals

This report page does not implement:

- charts
- finance snapshot-backed revenue pages
- costs, cash, or balance-sheet report pages
- booking type schema changes
- manual sync or operational Xero mutation flows
