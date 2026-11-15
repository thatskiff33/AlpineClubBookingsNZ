# Size allowances for #5126

file: src/lib/booking-batch-modification-service.ts
lines: 2763
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/lib/booking-date-modification-service.ts
lines: 2256
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/lib/booking-guest-removal-service.ts
lines: 1236
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/lib/payment-recovery.ts
lines: 3642
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1814
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside the function `modifyBookingBatch`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/lib/booking-date-modification-service.ts#modifyBookingDates
lines: 1180
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside the function `modifyBookingDates`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/lib/booking-guest-acceptance-reprice.ts#repriceBookingAfterGuestAcceptance
lines: 355
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside the function
  `repriceBookingAfterGuestAcceptance`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/booking-guest-removal-service.ts#removeBookingGuestInTransaction
lines: 828
reason: the in-transaction edit card refund reserve and its door wiring
  (#4992); those lines sit inside the function
  `removeBookingGuestInTransaction`, which was already over its limit before
  this change, and lifting it apart is a refactor of its own, not part of this
  fix.
