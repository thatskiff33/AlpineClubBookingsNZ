# Size allowances for #5505 (#5433, the rest of the hold-deadline job)

file: src/lib/email/booking.ts
lines: 1864
reason: two senders (the split-guest cancellation and the saved-card failure
  email) carry their owed notice's event key through to sendEmail, and both
  take their template name from the one module the reader also uses. The key
  has to pass through the sender, which is the one render of each email.

function: src/lib/cron-confirm-pending.ts#resolveHoldWindowUnderLock
lines: 517
reason: thirteen lines, the marker writes for the four branches that change a
  booking, each with a one-line comment. A marker has to be the last write of
  its branch, inside the transaction that holds the locks, so it cannot move
  out of this function; the bumped event's write already was moved out.
