# File-size allowances for #4312 (a card refund on a bank transfer gets its own Xero note)

The rule and its writers live in two new modules written to their own
ceilings (`card-refund-own-note-share.ts`, the record's side read by the enqueue
and the note's execution; `card-refund-own-note.ts`, the writers' side). Each
entry below is the seam into an existing flow, which belongs where that flow is.
Two files at their budget were kept at it rather than allowed.

file: src/lib/xero-operation-outbox.ts
lines: 3380
reason: the `cardRefundId` option of `enqueueXeroRefundCreditNoteOperation` -
  its sizing branch, key, dedupe rows, payload and the worker passing it on -
  beside the `paidAnotherWayTaskId` route it mirrors, in the one enqueue every
  refund note goes through.

file: src/lib/xero-credit-notes.ts
lines: 1381
reason: the same option in `createXeroCreditNote`: its delta-mode default, its
  share, its Xero key and the field riding the executed row, beside the close's
  branch in the one executor every refund note runs through.

file: src/lib/payment-transactions.ts
lines: 1700
reason: the one card refund ledger writer reports which refunds it newly
  counted (`newlyCountedRefundIds`), so the webhook notes only a refund it is the
  first to record. The count is made in that loop and nowhere else.

file: src/lib/stripe-webhook-service.ts
lines: 1779
reason: `charge.refunded` hands its delta and its newly counted refunds to
  `queueWebhookCardRefundNotes` instead of the one enqueue call, and runs its
  late-capture checks for a refund newly recorded when the total did not move.

file: src/lib/xero-operation-retry.ts
lines: 2082
reason: an operator's retry keeps a card refund's note its own (`cardRefundId`,
  read from the payload or else the row's key, which an older worker's
  payload rewrite keeps), beside the other fields a retry must keep.
