# Finance Booking Metrics Contract

This document defines the finance-only booking metrics query boundary.

It is intentionally narrow. The finance booking metrics boundary exposes AlpineClubBookingsNZ booking-derived stay and pipeline metrics as JSON for later finance reporting work, but it does not add finance UI pages, reporting-page components, or booking type schema changes.

## Boundary

- `src/lib/finance-booking-metrics.ts` is the canonical finance query layer for AlpineClubBookingsNZ booking metrics.
- `src/app/api/finance/bookings/metrics/route.ts` exposes that query layer through a finance-viewer read route.
- `src/lib/finance-api-auth.ts` remains the finance API authorization boundary and now distinguishes finance viewer read access from finance manager-only mutations.

## Inputs

The route accepts one or both of these window types:

- realized stay window:
  - `realizedFrom`
  - `realizedTo`
  - optional `realizedCutoff` (defaults to `realizedTo`)
- forward pipeline window:
  - `forwardFrom`
  - `forwardTo`
  - optional `forwardAsOf` (defaults to the current date when omitted)

All dates use `YYYY-MM-DD`.

At least one complete window is required. Partial realized or forward parameter pairs are rejected with `400`.

## Response Shape

The booking metrics response includes:

- `generatedAt`
- `bookingCount`: distinct AlpineClubBookingsNZ bookings contributing to any requested metrics section
- `moneyReconciliation`: the canonical derived reconciliation summary for that
  same contributing-booking cohort: `totalBookings`, `byState` counts for
  `RECONCILED` and `UNRECONCILED`, and a count for every canonical typed reason
  in `byReason`. It never recalculates, corrects, or suppresses stored amounts.
- `paymentSummary`: distinct-booking summary derived from AlpineClubBookingsNZ `Payment` rows
- optional `realized`
- optional `forward`

`paymentSummary` includes:

- booking coverage counts: `bookingCount`, `bookingsWithPayment`, `bookingsWithoutPayment`
- primary payment status counts plus `NONE` for bookings without a payment row
- additional payment status counts plus `NONE`. A legacy row with no
  `additionalPaymentStatus` but a real uncollected `additionalAmountCents`
  counts as `PENDING`, not `NONE`, so the split cannot contradict
  `outstandingAdditionalCents` below it
- `capturedGrossCents` (#2408, renamed from `capturedPrimaryCents`): gross
  captured cash — `Payment.amountCents` summed over the payments whose status
  says money was taken. `reconcilePaymentAggregates` sets that column to the sum
  of EVERY captured ledger row, PRIMARY and ADDITIONAL alike, so this figure
  already contains any collected price increase. The old name read as "the
  primary leg only" and invited the double count #2408 fixed
- `capturedAdditionalCents`: how much of `capturedGrossCents` came from a later
  price increase. A **breakdown** of that total, never an addend beside it
- `outstandingAdditionalCents` and `outstandingAdditionalBookings` (#2350): the
  money and booking count behind an upward change that was never collected -
  `additionalAmountCents > 0` where `additionalPaymentStatus` is anything other
  than `SUCCEEDED`, on a booking whose status is `CONFIRMED`, `PAID` or
  `COMPLETED` (the shared `isAdditionalPaymentOwed` predicate; a cancelled
  booking keeps its delta columns and must never be counted as owing). It is
  already inside the booked revenue figure, so subtracting it is what
  "collected" looks like. Window-scoped like every other figure here, so it will
  legitimately differ from the all-time dashboard/sidebar queue counts and from
  the reports summary's own date range
- `additionalLedgerGapCents` and `additionalLedgerGapBookings` (#2408, the
  guard): money on payments that CLAIM a collected price increase
  (`additionalPaymentStatus = "SUCCEEDED"` with a non-zero
  `additionalAmountCents`) and have no captured ADDITIONAL `PaymentTransaction`
  behind it. That is the only shape in which `capturedGrossCents` does not
  contain the increase, and therefore the only shape in which
  `netCollectedCents` understates the cash — by up to this amount. Healthy data
  cannot produce it (`reconcilePaymentAggregates` derives both columns from the
  latest ADDITIONAL row, so a SUCCEEDED status implies a captured row), but an
  import, a repair pass or a future write path could. Non-zero raises a
  `logger.error` naming the bookings and a warning on the finance dashboard
  beside the cash card; reconcile those payments' ledgers before trusting the
  collected total. An UNCOLLECTED increase is not this shape — it is absent from
  the captured total by design and reported by `outstandingAdditionalCents`
- `refundedCents`
- `netCollectedCents`: `capturedGrossCents - refundedCents`, floored at zero.
  **Never** the sum of `capturedGrossCents` and `capturedAdditionalCents` — that
  was the #2408 double count, which reported a $121 booking with a collected $21
  increase as $142 collected
- `creditAppliedCents`
- `changeFeeCents`

`realized` includes:

- the requested and effective realized window
- totals for `bookingCount`, `bookingNights`, `guestNights`, `bookedRevenueCents`, `averageNightlyRevenueCents`, and occupancy
- explicit per-status totals for `CONFIRMED`, `PAID`, and `COMPLETED`
- a daily series with `bookingCount`, `guestNights`, `occupiedBeds`, `availableBeds`, `occupancyRate`, and `bookedRevenueCents`

`forward` includes:

- the requested and effective forward window
- totals for:
  - `committed`
  - `atRisk`
  - `totalPipeline`
- committed status totals for `CONFIRMED` and `PAID`
- at-risk totals for `PENDING`
- a daily series that splits each date into `committed`, `atRisk`, and `totalPipeline`

## Metric Rules

- Booking and guest inclusion rules come from `docs/finance-dashboard/data-contracts.md`.
- Collected cash is counted once (#2408). `Payment.amountCents` is the gross
  capture — the sum of every captured ledger row — so
  `netCollectedCents = capturedGrossCents - refundedCents`, and
  `capturedAdditionalCents` is a part of `capturedGrossCents` rather than
  something to add to it. `additionalLedgerGapCents` measures exactly the
  population where that containment cannot be proved from the ledger, and is
  zero in healthy data.
- The cash total is read from `Payment.amountCents` and is **never rebuilt by
  summing `PaymentTransaction` rows** (#2408). A captured payment can legitimately
  have no PRIMARY row — an organiser-settled group booking, or anything written
  before the ledger existed — so a ledger-derived total would report a booking
  that collected $121 as having collected nothing, or as having collected only
  its $21 increase. The ledger's job here is narrower: to prove or disprove a
  CLAIMED increase, which is why only ADDITIONAL rows are loaded.
- Booked revenue always comes from AlpineClubBookingsNZ `Booking.finalPriceCents`, not `Payment`.
- When revenue is exposed at nightly granularity, `Booking.finalPriceCents` is allocated evenly across stay nights from `checkIn` inclusive to `checkOut` exclusive.
- A booking can contribute to both realized and forward sections when its stay spans the realized cutoff or forward `asOfDate`.
- Forward metrics count only stay dates strictly after `forwardAsOf`.
- Waitlist states remain excluded from occupied or committed pipeline nights.
- Finance dashboard consumers carry `moneyReconciliation` with every
  booked-revenue-derived figure. The bookings view separately exposes its
  primary and comparison cohorts; pricing sensitivity exposes its primary
  cohort. Each emits the state and non-zero reason counts in its warning and
  reconciliation panel, and the dashboard export carries the same panel rows.
  An unreconciled cohort leaves its stored amount visible but explicitly marks
  booked/forward revenue, realized rate, revenue less costs, comparisons, and
  scenarios as requiring review rather than silently trusted.

## JSON Safety Rules

- All timestamps are returned as ISO-8601 strings.
- All dates are returned as `YYYY-MM-DD`.
- The query layer returns plain objects, arrays, numbers, strings, booleans, and `null` only.

## Explicit Non-goals

This booking metrics boundary does not implement:

- finance UI pages
- reporting-page components or charts
- booking type schema changes
- Checkfront compatibility layers
- operational Xero connection or snapshot pipeline changes
