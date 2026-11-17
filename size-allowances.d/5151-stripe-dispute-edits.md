# Size allowances for #5151 (disputed edit reductions, #5061 follow-up)

Each edit door that was already over budget gains the dispute-hold read under
its own locks or carries the `refundHeldForDispute` flag through its result to
the Xero settlement. The decision itself lives in
`booking-modify-settlement-options.ts` and `booking-modify-settlement.ts`.

file: src/lib/booking-guest-removal-service.ts
lines: 1239
reason: holds a disputed edit reduction for the treasurer; those lines sit
  inside this file, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.

function: src/components/edit-booking/price-summary-card.tsx#PriceSummaryCard
lines: 488
reason: holds a disputed edit reduction for the treasurer; those lines sit
  inside the function `PriceSummaryCard`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1817
reason: holds a disputed edit reduction for the treasurer; those lines sit
  inside the function `modifyBookingBatch`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/booking-date-modification-service.ts#modifyBookingDates
lines: 1182
reason: holds a disputed edit reduction for the treasurer; those lines sit
  inside the function `modifyBookingDates`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/booking-guest-acceptance-reprice.ts#repriceBookingAfterGuestAcceptance
lines: 356
reason: holds a disputed edit reduction for the treasurer; those lines sit
  inside the function `repriceBookingAfterGuestAcceptance`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/lib/booking-guest-removal-service.ts#removeBookingGuestInTransaction
lines: 829
reason: holds a disputed edit reduction for the treasurer; those lines sit
  inside the function `removeBookingGuestInTransaction`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.
