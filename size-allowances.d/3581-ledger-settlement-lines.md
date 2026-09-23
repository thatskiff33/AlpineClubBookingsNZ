# File-size allowances for #3581 — settlement lines converge at the chokepoint

Two already-over-budget files grow, by a call each and the reason for it. The
work itself was split rather than allowed for: the planner
(`booking-ledger-settlement-posting.ts`), the store-facing sync
(`booking-ledger-settlement-sync.ts`), and the two predicates both it and the
mirror must share (`payment-transaction-status.ts`, moved OUT of
`payment-transactions.ts`, which is why that file grows by only four) are new
modules, each inside its own budget.

file: src/lib/payment-transactions.ts
lines: 1192
reason: one call at the end of `reconcilePaymentAggregates` — the one place
  the payment mirror is derived from its rows, and so the one place the
  ledger's settlement lines can converge from the same rows — plus its import
  and comment. Moving the two status predicates out to a leaf took back most
  of what the call added.

file: src/lib/payment-reconciliation.ts
lines: 3047
reason: the two explicit calls for the paths that deliberately bypass the
  chokepoint — the manual mark-paid settle and its reversal, which write their
  rows and the payment's columns themselves — each with the comment that says
  why it is here. The single settle door is a known split candidate; splitting
  it inside a ledger change would make both unreviewable.
