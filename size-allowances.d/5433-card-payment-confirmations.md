# File-size allowances for #5433 PR 3 (card-payment confirmations)

file: src/lib/email/booking.ts
lines: 1859
reason: the booking confirmation's sender carries the owed notice's event key
  through to sendEmail (a typed context field and one conditional spread), so a
  recovered send finds the first one's row; every other caller's call is
  unchanged. The sender is the one render of the confirmation, so the key has
  to pass through it.

function: src/lib/email/booking.ts#sendBookingConfirmedEmail
lines: 455
reason: the same two lines inside the sender's one sendEmail call.

file: src/lib/cron-confirm-pending.ts
lines: 1971
reason: one import, for the delivery that replaces the job's own render of the
  saved-card confirmation (the line count of that branch is unchanged).
