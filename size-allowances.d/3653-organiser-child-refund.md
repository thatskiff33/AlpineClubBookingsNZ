# File-size allowances for #3653

The organiser child's refund logic lives in three new modules
(`organiser-child-refund.ts`, `-executor.ts`, `-audit.ts`). What remains in the
files below is the call site at each door, which has to sit where the door
decides, in the transaction that decides: moving it out would split the
decision from the transaction it must commit in.

file: src/lib/booking-batch-modification-service.ts
lines: 2644
reason: the edit door writes the organiser child's refund debt inside its own
  transaction after its BookingModification row exists, and carries the decision
  to the post-commit refund; both belong at the point the door decides.

file: src/lib/booking-date-modification-service.ts
lines: 2351
reason: the same debt write and carried decision as the batch edit, at the
  date edit's own transaction, for the same reason.

file: src/lib/booking-guest-removal-service.ts
lines: 1534
reason: the same debt write and carried decision as the batch edit, at the
  guest removal's own transaction, plus the result field the route reads.

file: src/lib/payment-recovery.ts
lines: 3328
reason: the recovery dispatcher must route an organiser child's refund before it
  reads the child's transactions, which is a branch in the dispatcher itself;
  and the payments run re-reads pending child refunds after its queue, in the
  run itself (the sweep lives in the executor).

file: src/lib/payment-transactions.ts
lines: 1559
reason: the one refund-ledger writer is exported for the combined-charge refund
  rather than copied, which is a two-line change to its signature.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1020
reason: the repair's raise-only branch calls the Stripe-evidence cap at the
  point it computes the raise; the cap itself lives in organiser-child-refund.ts.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 566
reason: the guest removal's Xero dispatch tells the classifier the organiser
  child refund raises the one credit note - a flag at the call it governs.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1725
reason: the guest add sizes its own ask (the fifth ask door), so the refusal of
  an ask on a booking the organiser paid for by card sits where it is sized.

file: src/lib/group-settlement.ts
lines: 1650
reason: the settlement intent's paid-settlement stop is one condition plus the
  reason it changed, at the guard it replaces.

file: src/lib/member-guest-consent-service.ts
lines: 1283
reason: the consent-lapse sweep's credit election has to know, under its own
  lock, whether the organiser paid for the booking by card; one wider select
  and the conditional election at the call.
