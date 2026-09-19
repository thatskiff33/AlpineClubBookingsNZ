# File-size allowances for #3537 (#3529) — how a refund went back, said in Xero

Four already-over-budget files grow. Two files that stood one line under their
budget on main — `edit-financial-review-settlement.ts` and
`manual-refund-task-resolution.ts` — were SPLIT rather than allowed over: the
refund-side refusal sentences went to `edit-financial-review-refund-refusals.ts`
on the seam #3181 cut for the charge side, and the closer's input type went to
`manual-refund-task-resolution-input.ts`. The wording itself, and the reading
of which account settles a note, are new leaf modules (`xero-refund-method.ts`,
`resolveRefundSettlement` in `xero-invoice-payments.ts`) written to their own
ceilings; what remains below is the call into them from the four places a
refund note is minted, repaired, queued or checked for, and each of those is
one branch inside a transaction-shaped function that already exists.

file: src/lib/xero-credit-notes.ts
lines: 1069
reason: the cash-refund builder now asks `resolveRefundSettlement` whether a
  settling payment may be recorded and, when it may not, closes the operation
  with `refundPaymentSkipped` instead of calling `createPayments`. That
  decision has to sit at the exact point between "note created" and "payment
  recorded", inside the try/catch that already partitions PARTIAL from
  SUCCEEDED, because the skip is a third terminal shape of that same block
  and the repair leg reads the flag this block writes. The growth is that
  branch, the log line saying WHY the note is unsettled, and the wording
  builders replacing the two literals; the decision itself lives elsewhere.

file: src/lib/xero-operation-retry.ts
lines: 1547
reason: the repair leg makes the SAME settlement decision as the inline leg
  and must never make a different one - a PARTIAL note whose payment leg was
  skipped by design is complete, not a leg to re-drive, or the repair would
  mint the very Stripe-account payment the owner declined. Reading the
  recorded method off the payload, defaulting from the payment's source for
  pre-#3529 rows, and threading it into the modification-note retry are each
  a few lines beside the parse-and-repair pair they belong to; a separate
  module would hold one call and the reason it must match the inline one.

file: src/lib/xero-operation-outbox.ts
lines: 3292
reason: `refundMethod` joins the two enqueue signatures and the two executor
  pass-throughs, exactly where `createdByMemberId` already travels. The outbox
  is the one place a payload is written and read, and a field added anywhere
  else would be a field the outbox contract test could not see.

file: src/lib/setup-readiness.ts
lines: 2172
reason: the Setup Completeness snapshot gains one optional field and the
  detail line that says what happens while the bank-transfer refund account is
  unset. The snapshot is the single shape every readiness surface reads; the
  sentence itself is owned by the mapping registry
  (`describeMappingWhileUnset`), so these lines are the field and its render.
