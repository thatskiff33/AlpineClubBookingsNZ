# Finance Booking Metrics Contract

This document defines the finance-only booking metrics query boundary added for phase `#96`.

It is intentionally narrow. The finance booking metrics boundary exposes TACBookings booking-derived stay and pipeline metrics as JSON for later finance reporting work, but it does not add finance UI pages, reporting-page components, or booking type schema changes.

## Boundary

- `src/lib/finance-booking-metrics.ts` is the canonical finance query layer for TACBookings booking metrics.
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
- `bookingCount`: distinct TACBookings bookings contributing to any requested metrics section
- `paymentSummary`: distinct-booking summary derived from TACBookings `Payment` rows
- optional `realized`
- optional `forward`

`paymentSummary` includes:

- booking coverage counts: `bookingCount`, `bookingsWithPayment`, `bookingsWithoutPayment`
- primary payment status counts plus `NONE` for bookings without a payment row
- additional payment status counts plus `NONE`
- `capturedPrimaryCents`
- `capturedAdditionalCents`
- `refundedCents`
- `netCollectedCents`
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
- Booked revenue always comes from TACBookings `Booking.finalPriceCents`, not `Payment`.
- When revenue is exposed at nightly granularity, `Booking.finalPriceCents` is allocated evenly across stay nights from `checkIn` inclusive to `checkOut` exclusive.
- A booking can contribute to both realized and forward sections when its stay spans the realized cutoff or forward `asOfDate`.
- Forward metrics count only stay dates strictly after `forwardAsOf`.
- Waitlist states remain excluded from occupied or committed pipeline nights.

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
- finance Xero or snapshot pipeline changes
