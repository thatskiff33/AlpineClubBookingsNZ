# File-size allowance for #3924 (rounds 3 to 5)

PR #3924 (issue #3372) adds the "Paid another way" close of a dead card refund
(owner, 7 Oct 2026: "Count + add close action"). The close itself lives in its
own module (`src/lib/card-refund-paid-another-way.ts`).

file: src/lib/payment-transactions.ts
lines: 1579
reason: `applyLocalRefundAllocation` takes the charges to place a by-hand
  refund on first (`preferTransactionIds`), so a dead card refund closed as
  paid another way lands on the charges it was meant to come off - a superseded
  intent's must, or the reconciliation would read that charge as still live.
  The allocation's compare-and-set loop is the one writer of a local refund and
  the ordering belongs inside it; a second allocator beside it would be a copy.
  Round 4 (C2, C3): `refundPaymentTransactions` reports a slice Stripe refunded
  but the ledger could not record as a `PartialRefundError`, so no caller
  re-queues a recorded slice, and the allocation's "exceeds captured" refusal
  is a typed error a caller can tell from a fault. Both belong to the two
  functions that raise them.

file: src/lib/xero-operation-outbox.ts
lines: 3299
reason: round 4 (M3): `enqueueXeroRefundCreditNoteOperation` takes the record
  of a paid-another-way close as a key part (`paidAnotherWayTaskId`), so the
  close's bank-transfer note is a row of its own beside any card delta and is
  never deduplicated into one. It is one option and one key segment on the one
  refund-note enqueue; a second enqueue beside it would copy its coverage and
  resolved-in-Xero fences.
