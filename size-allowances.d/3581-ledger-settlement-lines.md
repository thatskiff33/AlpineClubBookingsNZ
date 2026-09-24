# File-size allowances for #3581 — settlement lines converge at the chokepoint

Two already-over-budget files grow, by a call each and the reason for it. The
work itself was split rather than allowed for: the planner
(`booking-ledger-settlement-posting.ts`), the store-facing sync
(`booking-ledger-settlement-sync.ts`), and the two predicates both it and the
mirror must share (`payment-transaction-status.ts`) are new modules, each
inside its own budget. Moving those predicates — and their docblock — OUT of
`payment-transactions.ts` more than paid for the chokepoint's call, so that
file ends shorter than it started and needs no allowance.

file: src/lib/payment-reconciliation.ts
lines: 3047
reason: the two explicit calls for the paths that deliberately bypass the
  chokepoint — the manual mark-paid settle and its reversal, which write their
  rows and the payment's columns themselves — each with the comment that says
  why it is here. The single settle door is a known split candidate; splitting
  it inside a ledger change would make both unreviewable.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1701
reason: one call after the Internet Banking receipt row is written — the one
  receipt writer that sets the payment's columns itself rather than ending in
  `reconcilePaymentAggregates`, which review of #3604 found the first cut had
  missed — plus its import and the comment that says why it is here.
