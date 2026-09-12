- Fixed: a second booking edit no longer deletes the first edit's unpaid extra. An
  extra raised by a price increase is now sized at everything still owed once the
  edit lands - the edit's own difference plus any change fee plus the unpaid
  balance of the extra it replaces - instead of the difference alone. Two
  consecutive increases used to ask for the second one only, and the first
  quietly stopped being owed.
- Fixed: an extra that has been replaced by a later edit is cancelled immediately
  rather than up to five minutes later, so a payment page still holding the old
  details cannot complete a charge against it. The booking's payment card now
  takes the amount it shows and the charge it makes from the same place, so it
  can never display one figure and charge another.
- Added: when a replaced charge is captured and refunded, the club now records it
  in the booking history and the audit log, emails the member an explanation
  naming what was refunded and what is still owing, and alerts administrators.
  Previously the payment provider's own receipt was the only notice anyone got.
- Changed: the payments board shows what the club actually holds - the amount
  paid less any refund - with the gross amount and the refund printed underneath
  a partially refunded payment.
- Added: an operator census that lists any booking whose money does not add up
  (`npm run payments:audit-booking-ledger`). It reports only; it never changes
  anything.
