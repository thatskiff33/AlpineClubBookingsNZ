# File-size allowances for #3880

A review's card refund or bank-transfer hand-back on an already-cancelled
booking now raises the refund credit note the cancellation's own card refund
raises. The rule lives in `edit-financial-review-xero-leg.ts`; what the outbox
adds is one option on the existing refund-note enqueue, so the review's note
goes through the same enqueue, coverage cap and outbox row as every other
refund note rather than a second copy of them.

file: src/lib/xero-operation-outbox.ts
lines: 3275
reason: the `reviewTaskId` option has to sit on `enqueueXeroRefundCreditNoteOperation`,
  whose correlation key and coverage cap it changes; a wrapper elsewhere would
  have to restate both. Its doc, one flag and one key part are the addition.
