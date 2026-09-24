# File-size allowances for #3581 — settlement lines converge at the chokepoint

Two already-over-budget files grow, by a call each and the reason for it.
`payment-reconciliation.ts`'s growth (the manual settle's and its reversal's
explicit calls) is counted in #3595's entry, which this stack re-measured —
one path, one allowance, while both are measured against `main` together. The
work itself was split rather than allowed for: the planner
(`booking-ledger-settlement-posting.ts`), the store-facing sync
(`booking-ledger-settlement-sync.ts`), and the two predicates both it and the
mirror must share (`payment-transaction-status.ts`) are new modules, each
inside its own budget. Moving those predicates — and their docblock — OUT of
`payment-transactions.ts` more than paid for the chokepoint's call, so that
file ends shorter than it started and needs no allowance.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1704
reason: one call after the Internet Banking receipt row is written — the one
  receipt writer that sets the payment's columns itself rather than ending in
  `reconcilePaymentAggregates`, which review of #3604 found the first cut had
  missed — plus its import and the comment that says why it is here; and
  #3599's two credit-sync calls after the credit rows this path mints for a
  cancelled booking, plus that import (re-measured by #3599, stacked on this).
