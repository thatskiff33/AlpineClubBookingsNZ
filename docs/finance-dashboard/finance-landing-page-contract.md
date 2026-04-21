# Finance Landing Page Contract

This document defines the native `/finance` landing page shell added for phase `#97`.

It is intentionally small. The landing page surfaces live finance sync health and TACBookings booking summaries for finance viewers and managers, but it does not implement report pages, charts, or manual sync controls.

## Boundary

- `src/app/(finance)/finance/page.tsx` renders the native finance landing page.
- `src/app/(finance)/finance/layout.tsx` remains the page-level finance viewer guard and shared finance shell.
- `src/lib/finance-landing-page.ts` is the loader and view-model boundary for the landing page.

## Data Sources

- Sync health comes from `src/lib/finance-sync-diagnostics.ts`.
- Booking summary cards come from `src/lib/finance-booking-metrics.ts`.
- Finance access stays gated by `src/lib/finance-auth.ts`.

The landing page must keep those source boundaries explicit in the UI:

- booking summary cards are TACBookings-derived metrics
- sync cards describe finance snapshot freshness and failures

## Default Windows

The landing page uses New Zealand local dates (`Pacific/Auckland`) for its booking summaries.

- realized cards:
  - from the first day of the current NZ-local month
  - through the current NZ-local date inclusive
- forward cards:
  - from the next NZ-local date after today
  - through the next 90 NZ-local dates inclusive
  - `forwardAsOf` is the current NZ-local date

## Viewer and Manager Behavior

- finance viewers and finance managers can load `/finance`
- viewers see the landing page summaries and section links
- manager-only diagnostics links may be shown only for capabilities that already exist
- manager-only diagnostics links must stay hidden from viewers

## Failure Handling

The landing page should degrade by section rather than fail the whole route whenever possible.

- if sync diagnostics fail, the sync section shows an unavailable state
- if booking metrics fail, the realized and forward sections show unavailable states
- one failing boundary must not prevent the other boundary from rendering

## Explicit Non-goals

This landing page does not implement:

- revenue, bookings, cash, or balance sheet report pages
- charts
- manual sync mutations
- booking type schema changes
- operational Xero behavior changes
