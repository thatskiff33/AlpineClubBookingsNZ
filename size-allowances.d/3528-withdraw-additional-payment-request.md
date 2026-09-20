# File-size allowances for #3528 — withdrawing an unpaid payment request

Two already-over-budget files grow, each by the one branch that makes a
withdrawal durable and honest. The service, its route, its button and its tests
are new files written to their own ceilings; `edit-financial-review-charge-request.ts`
takes one line and stays exactly at its budget rather than crossing it.

file: src/lib/payment-transactions.ts
lines: 1187
reason: `reconcilePaymentAggregates` now reads past an ADDITIONAL row stamped
  `withdrawnAt` when it derives the Payment's additional columns. That
  derivation is the one place those columns are written from the ledger, and
  the whole point of the stamp is that the projection cannot resurrect a
  withdrawn ask - so the filter has to sit at the derivation, beside the rule
  it qualifies (a FAILED row still projects as owed), not in a helper the next
  reader of `getLatestTransaction` would not know to call. One filter and the
  comment saying why FAILED alone could not carry the fact.

file: src/lib/xero-booking-repair-classify.ts
lines: 1666
reason: the review-charge arm gains a `withdrawn` branch that raises nothing,
  between the two branches (manual-review, queue) that decide what a missing
  supplementary invoice means for a review-priced edit. Read as either sibling
  a withdrawn request would park a fresh invoice on a cancelled intent; the
  branch and the comment saying so belong in the decision they are part of.
