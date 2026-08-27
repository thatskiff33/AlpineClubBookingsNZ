# File-size allowances for the payment-link expiry mint (#2870, CT-4 group F)

Three already-oversized modules grow by 42 lines between them. The growth is
**threading one value** — the club's persisted timezone — from before each
transaction into the four decisions bound to a payment link's expiry boundary,
plus returning the stored instant from the mint so the email cannot re-derive it.

The reasoning that could have been written into these files is deliberately NOT
in them. It lives in `src/lib/payment-link-expiry.ts` (a new 59-line module, well
inside its budget, which is also where the boundary itself now lives) and in
`docs/CONCURRENCY_AND_LOCKING.md` -> "Which client reads the club's timezone".
Each in-file comment was cut back to a pointer at those, which is what took the
growth from 60 lines to 34. `group-booking.ts` ends at 1763 lines, which is
EXACTLY its length on the base ref — the same, not shorter, and an earlier draft
of this file said "back under its ceiling", which it is not: it is 1063 over the
700-line domain-module budget both before and after. What the pointer-only
comments bought there was a net zero rather than a reduction, and that is worth
stating plainly in the file whose subject is published numbers. What is left is
code: import lines, one function parameter, one call argument, and one hoisted
`await` per lock boundary.

file: src/lib/payment-link.ts
lines: 1261
reason: the three mint paths here have to keep the zone read on the far side of
  the capacity lock, which is one hoisted await each and cannot be shortened
  without putting a settings query back under the lock. Eight of these lines are
  the review round's own: two docblocks in this file still said the link expires
  "in NZT", which `INV-CONFIG-002` forbids outright as an abbreviated spelling
  and `INV-CONFIG-001` forbids as one country's zone in a generic product, and
  one of them sits twenty lines above the body this change moved onto the
  persisted zone. Splitting the module is the right eventual answer at 1252
  lines against 700, but not in this change:
  it is a settlement boundary on a money path, and lifting the split-guest mint
  into its own file in the same diff would triple the review surface of the
  highest-risk lane in this epic for no correctness gain. The seam is real and
  should be its own pull request.
  #3123 adds nine: one import, one `bindClubTime(await
  readClubTimeZoneOutsideRequest())` with a five-line comment, and the binding
  passed into `resolveBookingNarrative`. The narrative names the day a
  payment, cancellation or settlement landed AT THE CLUB and was reading the
  container's zone; the stay dates beside it are `@db.Date` lodge nights and
  deliberately take none, which is the sentence the comment exists to leave
  behind. The seam this entry calls the right eventual answer is now filed as
  #2956 and is still not this change.

file: src/lib/cron-confirm-pending.ts
lines: 1703
reason: this file's two capacity-releasing PENDING -> CANCELLED decisions must
  be judged against the same club day as each other and as the mint, so the zone
  is read once at the top of the run and threaded through
  `resolveHoldWindowUnderLock` — a parameter, a docblock saying why it is a
  parameter and not a read, and one call argument. Splitting the cron would
  separate the terminal-state decisions from the hold-extension branch they are
  the exit from, which is the one relationship a reader of this file needs.

file: src/lib/booking-request.ts
lines: 2867
reason: two lines, at the existing pre-transaction settings-read block that the
  member-guest policy read four lines below already establishes. Anything else
  here would be a refactor of `approveBookingRequest`, which this change has no
  business touching.
