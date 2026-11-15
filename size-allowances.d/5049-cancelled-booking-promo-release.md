# File-size allowances for #5049 (issue #4909)

Each file below grows by exactly two lines: the import of
`releaseBookingPromoRedemptions` from `@/lib/promo` and the one call to it
inside the transaction that writes CANCELLED. INV-MONEY-005 requires the
release to run in that same transaction, after the guarded claim, so the call
cannot move to another module. Splitting any of these files to make room for
two lines would be an unrelated refactor of busy money and route code.

file: src/app/api/admin/bookings/[id]/review/route.ts
lines: 363
reason: the legacy-draft rejection must release the booking's promo uses in
  its own CANCELLED transaction; the route's transaction is where that write is.

file: src/lib/group-cancel.ts
lines: 1132
reason: each child's cancel transaction must release that child's promo uses
  before it commits; the release sits inside the per-child claim.

file: src/lib/payment-reconciliation.ts
lines: 2901
reason: the card capacity void must release the booking's promo uses in the
  same transaction that cancels it, before the hosting seam that stays last.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2106
reason: the late-capacity cancel on an inbound Xero payment must release the
  booking's promo uses inside its own CANCELLED transaction.
