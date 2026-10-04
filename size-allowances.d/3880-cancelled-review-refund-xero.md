# File-size allowances for #3880

A review's card refund or bank-transfer hand-back on an already-cancelled
booking now raises the refund credit note the cancellation's own card refund
raises. The rule lives in `edit-financial-review-xero-leg.ts`; what the outbox
adds is one option on the existing refund-note enqueue, so the review's note
goes through the same enqueue, coverage cap and outbox row as every other
refund note rather than a second copy of them.

file: src/lib/xero-operation-outbox.ts
lines: 3277
reason: the `reviewTaskId` option has to sit on `enqueueXeroRefundCreditNoteOperation`,
  whose correlation key and coverage cap it changes; a wrapper elsewhere would
  have to restate both. Its doc, one flag and one key part are the addition,
  and the task rides the row's payload into the builder (two lines).

The fix round (L1, L2 and the per-refund link rule) threads one guard and one
marker through the refund note's existing path rather than a parallel one; the
guard itself and the link lookup live in their own small modules
(`xero-refund-note-in-flight.ts`, `xero-refund-note-status.ts`).

file: src/lib/xero-credit-notes.ts
lines: 1199
reason: the in-flight check must sit between the row's own-note leg and its
  coverage read inside `createXeroCreditNote`, and the per-refund marker on the
  link and the payment-field skip belong to the record the builder writes.

file: src/lib/xero-sync.ts
lines: 995
reason: the single-active refund-note rule (`normalizePaymentRefundLinkWithClient`)
  and the canonical lookup are the two readers that must skip a per-refund
  note; the lookup itself was moved out to `xero-refund-note-status.ts`.

file: src/lib/xero-operation-retry.ts
lines: 1846
reason: the operator retry passes its REQUEUE row and the row's task into the
  same builder call; two spread lines and one option.
