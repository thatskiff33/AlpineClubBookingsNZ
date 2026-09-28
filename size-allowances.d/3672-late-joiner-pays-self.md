# File-size allowances for #3672 — a late joiner pays for themselves

Once an organiser-pays group's settlement is paid, a joiner the paid bill does
not cover pays for their own place (`INV-PAY-109`). The rule, the release of
left-behind joiners and their notice live in their own module
(`group-late-joiner.ts`), and the organiser's paid summary moved to
`pending-group-invoice.tsx`. What remains is the call at each site that decides
a joiner's payer. The growth of `group-settlement.ts` and
`email-message-registry.ts` is declared in the #3642 and #3638 fragments (one
allowance per file across the epic).

file: src/lib/booking-create.ts
lines: 2119
reason: the joiner's payer is re-decided under lock(1) inside the create
  transaction, right before the booking row it decides is written; outside it
  a settlement paid in between would be missed.

file: src/lib/group-booking.ts
lines: 1955
reason: the join reads its group's settlement and asks the shared rule who
  pays, the public summary tells a prospective joiner the same answer, and the
  join result reports the payer the booking was written with. Each is a line
  or two at the read it belongs to, with the comment saying why. The review
  round made close and reopen share one helper that takes lock(1), re-reads
  and writes with a not-CANCELLED guard; it belongs beside the ownership check
  and the two writers it serves.
