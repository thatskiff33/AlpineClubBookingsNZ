# File-size allowances for #3502 (PR #3948)

One already-over-budget file grows by three lines. The split was taken first:
the change-fee rule for a late primary invoice, its reasoning and its reads
live in a new module, `src/lib/xero-primary-invoice-change-fee.ts`, and the
fee line itself is the shared `changeFeeLineItem`. What is left is the import,
a one-line pointer and the one call.

file: src/lib/xero-booking-invoices.ts
lines: 1553
reason: the primary invoice must add its change-fee line where it assembles
  its other lines, between the promotion lines and the invoice body, so the
  call cannot move out of `createXeroInvoiceForBooking`. Everything else about
  it already lives in `xero-primary-invoice-change-fee.ts`.

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
lines: 2679
reason: the batch door writes its own BookingModification history row and its
  own transaction result; the offset and the retired asks join them there.

file: src/lib/booking-date-modification-service.ts
lines: 2343
reason: the date door writes its own BookingModification history row and its
  own transaction result; the offset and the retired asks join them there.

file: src/lib/booking-guest-removal-service.ts
lines: 1488
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
