# File-size allowances for #4866 (a cancellation leaves a live superseded capture alone)

The rule itself lives in its own new module, `superseded-capture-hold-back.ts`.
The two already-oversized files below gain only the wiring that has nowhere
else to go.

file: src/lib/booking-cancel.ts
lines: 2876
reason: the paid cancel claim reads the live superseded captures under its own
  Payment row lock, in the transaction that freezes its money figures and card
  plan, and hands the reading to both. The read must sit between the mirror
  fold and the plan, inside this claim; moving it out would read it outside the
  lock that makes it consistent with the hand-off's flip.

file: src/lib/payment-transactions.ts
lines: 1863
reason: one optional parameter threaded through the card planner
  (`planStripeRefundAllocation` -> `planCardRefundFromLedger` ->
  `buildRefundAllocationSlices`). These three are the single derivation of a
  card refund plan (`INV-PAY-131`), shared by the claim and the preview; the
  hold-back has to be applied inside it, not beside it.
