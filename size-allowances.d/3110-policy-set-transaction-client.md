# File-size allowances for #3110

Threading a Prisma client parameter through nine in-transaction call sites adds
one argument line per site. Seven files grew initially; the explanatory prose was
moved to its canonical home in `docs/CONCURRENCY_AND_LOCKING.md` ->
"Which client reads the cancellation and non-member-hold policy (#3110)", and the
gratuitous multi-line reformatting was collapsed, which took three files back to
or below their base length. These three are what is genuinely left: twelve lines in
total, of which eight are an argument or parameter that has to exist. The
advisory quote route needed no allowance in the end: its one `db: prisma` line
does not take the file past a ceiling it was already over on `main`.

file: src/lib/booking-batch-modification-service.ts
lines: 1480
reason: two lines, `db: tx` at the two helper calls this service makes while
  holding pg_advisory_xact_lock(1) and the per-lodge capacity lock. Splitting
  `modifyBookingBatch` to save two lines would cut a single locked transaction
  across a module boundary, which is the one refactor this file must not have.

file: src/lib/booking-guest-removal-service.ts
lines: 996
reason: one line, `db: tx`, inside `removeBookingGuestInTransaction`, which
  takes both locks itself. The seam that would carry it out does not exist and
  inventing one for one line would make the removal path harder to follow.

file: src/lib/booking-modify-plan.ts
lines: 2380
reason: one argument, two parameter lines, and a five-line note on the
  signature saying why `db` is required rather than defaulted here. That note
  is the exception to the sibling readers' pattern, so it belongs beside the
  parameter it qualifies -- moving it away is how the last such pair drifted.
  The full reasoning already lives in CONCURRENCY_AND_LOCKING.md; this is the
  pointer a reader needs at the signature.
  #3107 adds four more lines here: one import and a note on the single
  projection that reached the database, since `syncGuestNights` writes these
  values into `BookingGuestNight.stayDate` and the note is what tells the next
  reader why the in-progress branch changed and the ordinary one did not.
  Recorded in this entry rather than its own, because the gate measures against
  `main`, where the whole 2376 to 2380 growth is one change, and one file may
  hold only one allowance.
