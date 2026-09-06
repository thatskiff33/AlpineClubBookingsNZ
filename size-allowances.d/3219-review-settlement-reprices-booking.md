# File-size allowances for #3219 / #3260

Every file below is already over its budget on `main`, and each grows by the
same four: one import, plus one inline `a + b` replaced by a three-line call to
the one home for that relation (`bookingFinalPriceCents`, `INV-SSOT-001`, #3260).

**The growth is the extraction, and it is the extraction that pays for it.** A
booking's final price is its total plus its signed promotional adjustment; that
sentence was written out inline at twelve places, nine of which write the result
to a booking row. The promotional-adjustment column already replaced an older
discount column once, with a migration to backfill every pre-existing booking so
the two shapes would compute alike. When the relation next moves it has to be
found in twelve places and it will be changed in ten, and a booking whose stored
final price disagrees with its own total is the fault that surfaces in reporting
and reconciliation long after the change that caused it.

**Splitting any of these files is not available as an alternative here**, and
that is the point rather than an excuse: the four lines cannot move anywhere,
because the value they compute exists only at one point inside a long function —
the repriced total for THIS edit, held in a local the surrounding function then
writes to the booking row. Four of the call sites are ternaries whose PARKED
branch deliberately hands back the booking's STORED figure instead; extracting
the branch as well as the arithmetic would delete that distinction, which is the
one thing #3260 says must not happen. So each site keeps its decision and calls
the helper on its computed branch only.

These files' real size debt is untouched by this pull request and is not this
issue's to pay down.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1410
reason: the parked-add ternary (#3166) computes `newFinalPriceCents` from a
  local the surrounding handler wrote three lines earlier and immediately turns
  into `priceDiffCents`. Its parked branch is unchanged.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2325
reason: an advisory quote, not a write. The value is composed from the request's
  own pricing result inside the quote builder and never leaves it.

file: src/app/api/promo-codes/validate/route.ts
lines: 381
reason: shapes one JSON response field from the promo result the handler has
  just computed; there is nothing to lift out but the addition itself.

file: src/lib/booking-batch-modification-service.ts
lines: 2436
reason: one arm of the priced/parked ternary, beside the comment that says why
  the other arm writes the stored figure back. Both stay in place.

file: src/lib/booking-create.ts
lines: 1979
reason: three sites, one per creation path, each composing the final price from
  that path's own priced breakdown immediately before writing the booking row.

file: src/lib/booking-date-modification-service.ts
lines: 2094
reason: the parked/priced ternary, unchanged in shape; only its computed branch
  now calls the helper.

file: src/lib/booking-edit-guest-ranges.ts
lines: 1913
reason: the plan builder's single composition, feeding `priceDiffCents` on the
  next line.

file: src/lib/booking-guest-removal-service.ts
lines: 1335
reason: the parked-removal ternary, which carries the original statement of why
  the parked branch must not derive. That comment is untouched.

file: src/lib/waitlist.ts
lines: 1422
reason: composes the offer's final price from the reprice this function has just
  run, immediately before the booking write.

The last one is #3219 D2 rather than #3260, and it is comment.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 1568
reason: the condition itself is one line SHORTER than what it replaces — the
  growth is the paragraph beside it, which records that leaving the boxes blank
  used to be a valid answer and stopped being one, and why a disabled button here
  is not the bare refusal #3195 rejected. That reasoning cannot live anywhere but
  at the flag: `nightPricesBlocked` is derived from four locals this component
  computes while the officer types, and a reader who finds a settle control dead
  will look at the flag, not at a module elsewhere. The rule it enforces has its
  one home on the server (`stored-night-price-repair-store.ts`) and the sentence
  the officer reads has its one home in `stored-night-price-repair.ts`; neither
  is restated here.
