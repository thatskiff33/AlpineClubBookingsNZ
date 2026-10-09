# File-size allowances for #3502 (PR #3948)

No allowance of its own for `src/lib/xero-booking-invoices.ts` any more:
merging `main` (#3955) converged this PR's late-primary-invoice fee rule onto
#3750's (the recorded fee billed in full, `INV-PAY-119`), whose allowance
(`3750-finished-stay-change-request.md`) already covers the file at its
current length.

## #3954, built in the same PR: a reduction cancels or shrinks the unpaid ask

The rule, its reads and its writes live in new modules
(`src/lib/additional-ask-reduction.ts`, `src/lib/unpaid-ask-offset-marker.ts`)
and the arithmetic in `additional-payment-ask.ts`. What is left in each
oversized file below is plumbing at a call site that cannot move: a door
recording what its reduction set against the ask on the history row it already
writes, and carrying the retired asks to its after-commit step.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2549
reason: the quote must preview the same offset the save applies, beside the
  give-back preview it already computes in this handler; the read itself is the
  shared `reductionLeftAfterUnpaidAsk`.

file: src/lib/booking-batch-modification-service.ts
lines: 2910
reason: the batch door writes its own BookingModification history row and its
  own transaction result; the offset and the retired asks join them there.
  After merging #3955 it also decides, beside #3750's finished-stay fee write,
  whether `applyPaymentAdjustments` already recorded the fee (so it is recorded
  once), and sizes the correction's untiered options net of the unpaid ask.

file: src/lib/booking-date-modification-service.ts
lines: 2359
reason: the date door writes its own BookingModification history row and its
  own transaction result; the offset and the retired asks join them there.

file: src/lib/booking-guest-removal-service.ts
lines: 1490
reason: the removal door writes its own BookingModification history row and
  result type; the offset and the retired asks join them there.

file: src/lib/payment-recovery.ts
lines: 3340
reason: the intent-mint replay must recognise a reduction's re-issued ask where
  it sizes every replayed ask, or it would replay it as an increase and raise a
  supplementary invoice for a reduction. The "retry nets it off" round moved
  that sizing into `additional-ask-recovery-replay.ts`, shared with the
  reduction; what grew is the replay's docblock saying a netted row never
  reaches it.

file: src/lib/xero-booking-repair-classify.ts
lines: 2348
reason: the repair pass sizes a reduction's note and decides an increase's
  missing invoice inside its per-modification arms; the predicate and wording
  live in `unpaid-ask-offset-marker.ts`, and what is left is the arm itself,
  which also reads an increase whose unminted ask a reduction netted off.

file: src/lib/member-guest-consent-service.ts
lines: 1379
reason: a consent decline or expiry is a guest removal with its own
  after-commit finaliser; the asks its reduction retired are cancelled, and what
  is left re-issued, there, through the shared minter, as the DELETE door does -
  also when it netted off an unminted ask and retired no row.
