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
lines: 1522
reason: two lines, `db: tx` at the two helper calls this service makes while
  holding pg_advisory_xact_lock(1) and the per-lodge capacity lock. Splitting
  `modifyBookingBatch` to save two lines would cut a single locked transaction
  across a module boundary, which is the one refactor this file must not have.
  #3123 adds twenty more, fourteen of them one comment. FOUR decisions inside
  this batch's transaction read the club's day and must agree: the edit
  policy's gate, the promotion's validity window, the late-notice change fee's
  tier and the reduction refund's settlement tier. Three of the four move
  money, so two todays here would be a batch edit priced against itself. The
  day is resolved beside `subscriptionLockoutMode`, which this file already
  hoists for the same `INV-LOCK-004` reason `db: tx` exists for — so the note
  sits with its siblings rather than anywhere new.

file: src/lib/booking-guest-removal-service.ts
lines: 1044
reason: one line, `db: tx`, inside `removeBookingGuestInTransaction`, which
  takes both locks itself. The seam that would carry it out does not exist and
  inventing one for one line would make the removal path harder to follow.
  #3123 adds forty-eight, and roughly thirty-five are three docblocks.
  `removeBookingGuestInTransaction` gains a required `today` and
  `recalculateBookingPromo` a required `todayAtClub`, both resolved by the
  caller before it opened the transaction that holds the per-lodge capacity
  key and the promo row lock. The measured defect is the self-removal window:
  it compared a PROJECTED check-in against the container's day and released a
  member's bed a day before club policy allowed. Both operands moved together
  on purpose — the check-in is a `@db.Date` and is decoded zone-free, the
  right side arrives already resolved — because moving one alone is the #3107
  shape, where two projections cancelled and correcting one of them broke a
  path that had been working. The seam this entry says does not exist still
  does not exist.

file: src/lib/booking-modify-plan.ts
lines: 2433
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
  #3123 adds twenty-eight to this entry's running total, twenty-four of them
  three docblocks on three required parameters. `applyPromoCodeChanges` and
  `calculateModificationChangeFee` both run under `pg_advisory_xact_lock(1)`
  and the per-lodge capacity key, so neither can resolve the club's timezone —
  the same `INV-LOCK-004` rule that already makes `db` required here, which is
  exactly why the new notes sit beside `db`'s rather than anywhere else. The
  change fee's two `daysUntilDate` operands now measure from ONE club day
  instead of a local `new Date()` no other decision shared.
