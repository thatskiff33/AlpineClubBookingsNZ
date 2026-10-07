# File-size allowance for #3924 (round 3)

PR #3924 (issue #3372) adds the "Paid another way" close of a dead card refund
(owner, 7 Oct 2026: "Count + add close action"). The close itself lives in its
own module (`src/lib/card-refund-paid-another-way.ts`).

file: src/lib/payment-transactions.ts
lines: 1550
reason: `applyLocalRefundAllocation` takes the charges to place a by-hand
  refund on first (`preferTransactionIds`), so a dead card refund closed as
  paid another way lands on the charges it was meant to come off - a superseded
  intent's must, or the reconciliation would read that charge as still live.
  The allocation's compare-and-set loop is the one writer of a local refund and
  the ordering belongs inside it; a second allocator beside it would be a copy.
