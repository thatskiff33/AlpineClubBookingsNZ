# File-size allowances for #4628 (Ledger M3c)

Each binding door posts its journal R01 inside the transaction that already
holds its lock(1) and lodge key, right after the payment write it records, so
the call has to sit at that point in each door; the planning and posting live
in the new `booking-ledger-pending-charge.ts`, and each door gains only its
pre-transaction context read and one call.

file: src/app/api/bookings/route.ts
lines: 1872
reason: the internet-banking create's journal context must be read before the
  create's transaction opens (INV-LOCK-004), which is in this route.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 554
reason: the switch is a binding door: its pre-transaction context read and the
  R01 call inside its locked transaction, after the payment upsert.

file: src/lib/booking-create.ts
lines: 2070
reason: the internet-banking arm posts R01 right after its payment and its
  transaction row, inside the create's own lock(1) and lodge key; moving the
  arm out would split the create's one transaction across modules.

file: src/lib/booking-exception-approval.ts
lines: 1246
reason: the approval hands the create the journal context it already resolved
  for the batch executor, before its transaction.

file: src/lib/school-booking-request.ts
lines: 3229
reason: both pay-on-account arms are binding doors and post R01 beside their
  payment write, inside the approval's locked transaction; the school arm also
  reads its context before that transaction, on the zone it already reads.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2085
reason: the Xero receipt's PAID claim is a confirmation, so the confirmation's
  lines post right after it, inside the same lock(1) and lodge-key transaction,
  as the settle's do.

file: src/lib/group-booking.ts
lines: 1966
reason: an EACH_PAYS_OWN joiner paying by internet banking binds its charge in
  the create, so the join reads the journal context before the create's
  transaction, on the club zone it already reads, and passes it in.
