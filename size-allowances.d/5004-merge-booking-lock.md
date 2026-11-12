# File-size allowances for #5004

file: src/lib/member-merge.ts
lines: 3164
reason: The captured-booking try-lock has to be called from the `Booking.member`
  arm of `applyMoves`, immediately before that arm's update, and the booking
  ownership 409 is shared by the count check and the spent booking wait. The
  lock and its wait already live in `member-merge-booking-lock.ts`. What stays
  here is the call site, whose position the lock tests read from this file, and
  the one refusal both paths throw.
