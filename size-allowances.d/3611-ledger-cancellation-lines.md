# File-size allowances for #3611

Each cancel path posts its ledger lines inside the claim transaction that flips
the booking to CANCELLED, so the call has to sit in that transaction; there is
no seam outside it that runs under the same lock and the same client.

file: src/lib/booking-cancel.ts
lines: 2600
reason: one posting call in each of the five claim transactions (paid, unpaid,
  PENDING, no-payment, linked child), plus their imports; the paid claim reads
  its applied rows and takes refund, restore and kept from one call, so the
  kept figure is frozen in the same claim as the decision it records.

file: src/lib/group-cancel.ts
lines: 943
reason: one posting call in each child's claim transaction, with the reason a
  child keeps nothing.

file: src/lib/cron-confirm-pending.ts
lines: 2046
reason: one posting call, nothing kept, in each of the hold-window
  resolution's three cancel arms, inside the lock(1) transaction that cancels.

file: src/lib/payment-reconciliation.ts
lines: 3067
reason: one posting call, nothing kept, in the settle's capacity void, inside
  the lock(1) transaction that cancels; it has to sit where the void is.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1922
reason: one posting call, nothing kept, in the late-capacity cancel arm, inside
  the lock(1) transaction that cancels it and mints the credit; and (#3792,
  stacked on this branch) the full restore of the booking's applied credit in
  that same claim, with its booking event, beside the capacity void's own.
