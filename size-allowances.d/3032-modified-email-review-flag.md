# File-size allowances for #3032 (modified-email review flag)

Only ONE entry here, deliberately. Four of the five files this change grew are
already named by an allowance that has not merged yet — `guests/[guestId]`,
both booking-edit services and `src/lib/email/booking.ts` — and the rules in
this directory's README make two allowance files naming one path in a single
change an error. Those four had their recorded lengths refreshed in the
allowance that already owns them (`3031-exact-sold-price.md` and
`3033-pending-financial-review-visibility.md`) rather than being re-declared
here. This route is the one path no live allowance covers.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1264
reason: TWO additions, and the second is the larger one. The pending-review
  FENCE: this route is the fourth money-affecting door and had no fence on
  it, so an edit priced against a total under review, absorbed the
  overstatement into the stored `finalPriceCents` and let the same money
  leave twice at completion. The fence must run inside this transaction,
  after both locks and the post-lock re-read and below the 403, which is
  this function; most of its lines are the docblock saying what this route
  does to a booking under review, because "reprices inline in the route
  rather than through a service" is exactly why it was missed. Its 409
  branch is answered at the top of the catch chain because the error
  extends the shared `ApiError` and the generic branch drops the code.
  And, from the earlier round: making `financialReviewPending` a required parameter on the modified
  email enumerated every caller, and this route was the fifth — the one no
  hand-written list of call sites held. The fourteen lines are one read of
  whether the club is still working out an amount on this booking, the value
  handed to the email, and the comment saying why the honest answer here is the
  booking's current state rather than anything this edit decided. Splitting is
  not available for it: the read has to sit between the transaction committing
  and the email being composed, which is this function and nowhere else, and
  lifting the whole post-commit dispatch out of a 1,200-line route handler is a
  refactor of its own that would touch every guest-add path and its tests. The
  file was 938 lines over its 250-line budget independently of this change and
  stays over it by that margin plus fourteen.
