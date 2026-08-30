# File-size allowances for #3032

Three booking-edit services each gain the same call: the pending-review fence
that refuses a second money-affecting edit while the club is still working out
the money for the last one. Every one of them was already far over its budget
before this change, and each grows by one call plus the comment explaining why it
sits where it does.

The fence itself is NOT duplicated — the rule, the message, the machine code and
the narrow-by-design exemptions all live once, in
`src/lib/edit-financial-review.ts`, and these three sites call it. What cannot be
lifted out is the CALL, because its position is the safety property: it has to be
after both advisory locks, after the post-lock re-read, after the authorisation
checks, and before any write. A helper that "wrapped" the three services to move
those lines elsewhere would put the ordering rule somewhere other than the code
it orders, which is exactly how an ordering rule stops holding.

Splitting any of these three modules is a refactor of its own. They are the
booking-edit engines; a seam through them touches every lock-ordering comment,
every settlement branch and a large share of the booking test suite, and it
belongs on an issue where it can be reviewed as the domain change it is rather
than ridden in on a money-correctness fix. Each was over budget independently of
this change and stays over it by the same margin plus its one call.

file: src/lib/payment-recovery.ts
lines: 2107
reason: one more durable-recovery pair - enqueue and happy-path close - for the
  completed edit-financial-review refund, in the file where all nine of its
  siblings live. The alternative was reusing the modification-scoped pair, and
  that is the defect this change fixes: two review tasks can share one
  `BookingModification`, so they would upsert each other's recovery row and that
  upsert overwrites `amountCents` and `stripeKeyPrefix`. Putting a tenth pair
  anywhere but beside the other nine is how the next reader misses that they are
  a family with one shared upsert. The module was 1,181 lines over budget before
  this change. #3170 (+16): the additional-intent recovery enqueue takes its dedup key as a required argument instead of deriving it from the modification, so a review-completion charge can scope its own key rather than colliding with the ordinary edit's. #3170 fix round (+94): the review-charge branch of the additional-intent worker. A review charge REPLAYS differently from an ordinary edit - it re-derives the total from the settled shares rather than replaying a frozen amount, and it must not reach the "a newer additional supersedes this one" check below, which would see the request this very edit already minted and complete having minted nothing. That is the escape hatch through which the first round's second share was dropped, so the branch has to sit ahead of it, in this function. The same lines retire the inline prefix slice that derived a modification id from whatever key the operation carried: the parser now lives once, beside the builders, and this file calls it. #3170 fix round 2 (+36): that same branch used to complete its operation unconditionally, and the mint below it swallows a provider failure and re-enqueues the row it is already processing - whose upsert deliberately does not reset `status` - so a replay while the provider was still down marked the debt SUCCEEDED having minted nothing. The branch now reads the sync's outcome and throws on "not raised", which hands the row to the back-off, retry and admin-alert machinery already in this file. The reasoning has to sit on the branch, because nothing about the old two lines looked wrong.

file: src/lib/payment-transactions.ts
lines: 1159
reason: `applyLocalRefundAllocation` writes an absolute `refundedAmountCents`
  computed from a stale read, so two writers on one `PaymentTransaction` lose an
  update and overstate the refundable headroom. The fix is a compare-and-set on
  the value the slice was computed from, plus the docblock naming exactly which
  caller made that reachable and why every older caller is safe. That reasoning
  has to sit on the function it guards - it is the only place somebody removing
  the guard will read it. The module was 401 lines over budget before this
  change. #3170 fix round (+7): `isCapturedTransactionStatus` becomes exported
  rather than private. "Has this transaction's money actually been taken" had
  three inline spellings in this file and a fourth was about to be written in the
  review-charge module, which has to know whether an edit's combined request has
  already been PAID before another share may be added to it - `INV-SSOT`, one
  definition, imported.
