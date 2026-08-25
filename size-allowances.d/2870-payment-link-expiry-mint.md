# File-size allowances for the payment-link expiry mint (#2870, CT-4 group F)

Three already-oversized modules grow by 34 lines between them. The growth is
**threading one value** — the club's persisted timezone — from before each
transaction into the four decisions bound to a payment link's expiry boundary,
plus returning the stored instant from the mint so the email cannot re-derive it.

The reasoning that could have been written into these files is deliberately NOT
in them. It lives in `src/lib/payment-link-expiry.ts` (a new 58-line module, well
inside its budget, which is also where the boundary itself now lives) and in
`docs/CONCURRENCY_AND_LOCKING.md` -> "Which client reads the club's timezone".
Each in-file comment was cut back to a pointer at those, which is what took the
growth from 60 lines to 34 and took `group-booking.ts` back under its ceiling
entirely. What is left is code: import lines, one function parameter, one call
argument, and one hoisted `await` per lock boundary.

file: src/lib/payment-link.ts
lines: 1244
reason: the three mint paths here have to keep the zone read on the far side of
  the capacity lock, which is one hoisted await each and cannot be shortened
  without putting a settings query back under the lock. Splitting the module is
  the right eventual answer at 1244 lines against 700, but not in this change:
  it is a settlement boundary on a money path, and lifting the split-guest mint
  into its own file in the same diff would triple the review surface of the
  highest-risk lane in this epic for no correctness gain. The seam is real and
  should be its own pull request.

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
lines: 2853
reason: two lines, at the existing pre-transaction settings-read block that the
  member-guest policy read four lines below already establishes. Anything else
  here would be a refactor of `approveBookingRequest`, which this change has no
  business touching.
