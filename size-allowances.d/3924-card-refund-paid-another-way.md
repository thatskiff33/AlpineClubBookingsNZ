# File-size allowance for #3924 (rounds 3 to 8)

PR #3924 (issue #3372) adds the "Paid another way" close of a dead card refund
(owner, 7 Oct 2026: "Count + add close action"), and in round 7 the Resolved
mark on a refund paid back twice (owner, 9 Oct 2026). The close lives in its own
modules (`src/lib/card-refund-paid-another-way.ts`, `-xero.ts`, `-cash.ts`), the
Resolved mark in `src/lib/card-refund-paid-twice.ts`, and the repair tool's
receipt finding in `src/lib/xero-booking-repair-paid-another-way.ts`. What
remains below is one option or one call in each shared file the close reaches.

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
lines: 3344
reason: round 4 (M3): `enqueueXeroRefundCreditNoteOperation` takes the record
  of a paid-another-way close as a key part (`paidAnotherWayTaskId`), so the
  close's bank-transfer note is a row of its own beside any card delta and is
  never deduplicated into one. It is one option and one key segment on the one
  refund-note enqueue; a second enqueue beside it would copy its coverage and
  resolved-in-Xero fences. Round 7: the record selects the stepped path on any
  payment source (C8), and it and the invoice the note names (M5) ride the
  payload to the executor - two options on the same enqueue and dispatch.
  Round 8 (M3): the close's note is sized by its record less its own notes
  (`readPaidAnotherWayCloseShare`) and deduplicated on its own rows, inside the
  same stepped branch, so the enqueue's fences stay one copy.

file: src/lib/xero-credit-notes.ts
lines: 1331
reason: round 7 (M5, C8): `createXeroCreditNote` credits an invoice its caller
  names (`creditsInvoiceId`), and treats a paid-another-way close's note as one
  of several on a non-card payment, as it already does a review's. Both are
  inputs to the one refund-note builder's invoice choice and per-refund rule; a
  second builder would copy its coverage, settlement and crash-window handling.
  Round 8 (M3): at execution the close's note is sized by the same record
  share as the enqueue, is never closed against another note's link, and its
  Xero idempotency key names the close - all inside the delta-mode branch that
  already sizes every per-refund note.

file: src/lib/xero-operation-retry.ts
lines: 1954
reason: round 7: an operator's retry of a refund note passes the close and the
  named invoice through, as it passes every other recorded field, so a retried
  close's note credits the same document. Three lines beside their siblings.

file: src/lib/xero-booking-repair-classify.ts
lines: 2319
reason: round 7 (M2): one call, at the late-capture approval tasks it already
  walks, to the receipt finding, which lives in its own module
  (`xero-booking-repair-paid-another-way.ts`); the walk and its `continue`
  belong to the classifier.

file: src/lib/xero-sync.ts
lines: 1034
reason: round 8 (M1): `sumCoveredRefundCreditNoteCents` takes an optional set
  of note ids, so one close's share is counted by the very loop that counts the
  payment's coverage (`sumRefundCreditNoteCoverageOfRowsCents`). A second
  link-amount loop elsewhere would be the second definition of coverage the
  finding was about.
