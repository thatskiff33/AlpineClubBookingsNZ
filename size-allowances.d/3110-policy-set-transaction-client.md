# File-size allowances for #3110

Threading a Prisma client parameter through nine in-transaction call sites adds
one argument line per site. Seven files grew initially; the explanatory prose was
moved to its canonical home in `docs/CONCURRENCY_AND_LOCKING.md` ->
"Which client reads the cancellation and non-member-hold policy (#3110)", and the
gratuitous multi-line reformatting was collapsed, which took three files back to
or below their base length. These four are what is genuinely left: thirteen lines
in total, of which nine are an argument or parameter that has to exist.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2331
reason: one line, `db: prisma`, stating that this advisory quote holds no
  transaction and so is right to use the module client. The helper it calls
  requires the choice rather than defaulting it, which is the whole point of
  the change; there is no shorter way to say it and nothing here to split.

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
lines: 2376
reason: one argument, two parameter lines, and a five-line note on the
  signature saying why `db` is required rather than defaulted here. That note
  is the exception to the sibling readers' pattern, so it belongs beside the
  parameter it qualifies -- moving it away is how the last such pair drifted.
  The full reasoning already lives in CONCURRENCY_AND_LOCKING.md; this is the
  pointer a reader needs at the signature.
