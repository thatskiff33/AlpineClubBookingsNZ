# File-size allowances for #3371

Six already-over-budget files each gain nine to twelve lines, and every one of
them is the same edit: `createModificationAdditionalPaymentIntent` now takes an
`AdditionalAsk` — the figure and the balance minting it will absorb, as one
value — instead of a bare number. That is the structural device the owner's
13 September 2026 decision asked for (`INV-PAY-098`), and it only works if every
door that mints an ask is threaded onto it. A door that kept the old parameter
would be the door the money leaks through next.

The two files this change actually WROTE new logic into were split rather than
allowed: the carried-balance narration moved to
`src/lib/edit-financial-review-carried-balance.ts`, which is what keeps
`edit-financial-review-charge-request.ts` and `edit-financial-review-charge.ts`
inside their budgets with no allowance at all.

`edit-financial-review-charge.ts` lands at exactly its 700-line ceiling, and the
review round is why: three findings wanted explanations there. They were written
where the RULE lives instead — the concurrency limit in
`docs/CONCURRENCY_AND_LOCKING.md`, the orphaned supplementary invoice under
`INV-PAY-070`, the idempotency-key rule beside the helper in
`payment-recovery-keys.ts` — and the module carries a pointer to each. Anyone
adding to that file next needs a split, not prose discipline; an allowance
cannot help, because the ratchet refuses to carry a file over its budget for the
first time.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1535
reason: the guest-add door sizes its own ask, so it declares the value and
  passes it on. Its Stripe and Xero arms are deliberately two figures over one
  variable and a census pins them apart; lifting either out would separate the
  two arms the reviewer has to read together.

file: src/lib/booking-batch-modification-service.ts
lines: 2505
reason: eleven lines carrying the ask from `applyPaymentAdjustments` through the
  transaction result to the minter, plus the field's own explanation. The seam
  it would be split on is `applyPaymentAdjustments`, which already exists and is
  where the sizing happens; this file is only the conduit.

file: src/lib/booking-date-modification-service.ts
lines: 2224
reason: the same conduit change as the batch service above, for the same reason
  and in the same shape.

file: src/lib/booking-guest-removal-service.ts
lines: 1389
reason: the removal result carries the ask so its route can mint with it. Nine
  lines, all of them the field and the sentence saying why the plain figure
  beside it is not interchangeable with it.

file: src/lib/payment-recovery.ts
lines: 3144
reason: the ordinary edit's recovery replay mints and retires asks too, so it
  records what it absorbed. Putting that anywhere but beside the mint would put
  the write and its provenance in different files, which is the split that made
  this defect possible in the first place.

file: src/lib/payment-transactions.ts
lines: 1181
reason: the ledger writer gains the optional `carriedAskCents` and the docblock
  explaining why omitting it must leave a stored value alone rather than reset
  it. It belongs on the upsert it guards; a separate writer for one column would
  be a second way to write the same row.
