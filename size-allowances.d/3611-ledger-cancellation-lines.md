# File-size allowances for #3611

Each cancel path posts its ledger lines inside the claim transaction that flips
the booking to CANCELLED, so the call has to sit in that transaction; there is
no seam outside it that runs under the same lock and the same client.

file: src/lib/booking-cancel.ts
lines: 2573
reason: one posting call in each of the five claim transactions (paid, unpaid,
  PENDING, no-payment, linked child), plus two imports; the paid call carries
  the kept figure from the policy numbers frozen in that same claim.

file: src/lib/group-cancel.ts
lines: 964
reason: one posting call in each child's claim transaction, the frozen plan
  snapshot it reads (an inline refund failure clears the live one), and the
  paid-child test extracted so the plan and the posting ask it the same way.
