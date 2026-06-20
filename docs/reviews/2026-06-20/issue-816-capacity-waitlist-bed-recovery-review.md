# Issue #816: Capacity, Waitlist, Bed Allocation, and Recovery Review

## Issue

Review booking capacity, waitlist, bed allocation, stale holds, modifications, cancellations, draft cleanup, admin review, and recovery paths.

## Scope reviewed

- Static review of booking, waitlist, capacity, and bed-allocation flows.
- No bug fixes, app-code edits, live data, browser automation, load testing, or production checks were performed.

## Files/directories inspected

- `src/lib/booking-status.ts`
- `src/lib/capacity.ts`
- `src/lib/waitlist.ts`
- `src/lib/cron-waitlist.ts`
- `src/lib/bed-allocation-lifecycle.ts`
- `src/lib/booking-guest-removal-service.ts`
- `src/app/(admin)/admin/waitlist/page.tsx`
- `src/app/(admin)/admin/bed-allocation/page.tsx`
- `src/app/(authenticated)/book/page.tsx`
- `src/app/(authenticated)/bookings/[id]/page.tsx`
- `prisma/schema.prisma`
- Prior report: `issue-813-lifecycle-state-machine-review.md`

## Main observations

- Capacity-holding statuses are intentionally narrow: `PAID`, `COMPLETED`, `CONFIRMED`, and `AWAITING_REVIEW`.
- `PENDING`, `PAYMENT_PENDING`, and `WAITLIST_OFFERED` are not capacity-holding statuses, but they are bed-allocatable statuses.
- Waitlist progression uses advisory locks, rechecks capacity before confirmation, expires offers, and auto-cancels past waitlist records.
- Waitlist offer/expiry emails are sent after state changes and are best-effort.
- Bed-allocation reconciliation prunes invalid allocations and auto-allocates missing bed nights under feature/module gates.
- Admin waitlist force-confirm supports intentional overbooking with a warning and explicit confirmation.

## Top risks to verify

- Bed allocation can exist for statuses that do not hold capacity. Verify this does not mislead lodge/admin users or block beds operationally before capacity is actually reserved.
- Waitlist state changes can commit even if notification email delivery fails. Verify admin/user recovery when a user never receives an offer or expiry email.
- Force-confirm overbooking is an intentional admin escape hatch, but needs strong audit and test coverage around capacity consequences.
- Draft cleanup and stale hold cleanup need a status-matrix test so `PENDING`, `PAYMENT_PENDING`, `WAITLISTED`, and `WAITLIST_OFFERED` age out as intended.
- Booking modifications and guest removal need explicit bed-allocation repair assertions across changed date/guest ranges.

## Likely follow-up issues

- Add a booking status matrix test that compares capacity-holding, active, payment-owed, waitlist, and bed-allocatable statuses.
- Add recovery visibility for waitlist offer email failure after an offer has been created.
- Add admin audit/reporting around force-confirmed overbookings.
- Add tests for bed-allocation reconciliation after date changes, cancellations, guest removal, and module disable/enable.
- Add stale draft/hold cleanup coverage for non-member and payment-pending paths.

## Recommended tests/static checks

- Unit tests for `checkCapacityForGuestRanges` across every booking status.
- Unit tests for waitlist offer confirmation after capacity changes.
- Cron tests for expired waitlist offers and past waitlist bookings.
- Integration tests for booking modification and cancellation bed-allocation cleanup.
- Static check that capacity-holding and bed-allocatable status changes require reviewer attention.

## Sensitive findings requiring private handling, if any

- If overbooking or stale-hold bypass conditions are confirmed, keep exact reproduction paths out of public issue bodies.

## Uncertainty/to-verify list

- To verify: whether a scheduler reliably runs stale draft, waitlist, and payment-pending cleanup jobs.
- To verify: whether lodge UI distinguishes allocated beds from capacity-reserved beds.
- To verify: whether all force-confirm and overbook actions are surfaced in audit views used by operators.
- To verify: whether module-gated bed allocation state is reconciled after feature toggles.

## Validation notes

- Static review only.
- No app-code edits, tests, browser automation, or live-data checks were run.
