# File-size allowances for #4628 (Ledger M3c)

Each binding door posts its journal R01 inside the transaction that already
holds its lock(1) and lodge key, right after the payment write it records, so
the call has to sit at that point in each door; the planning and posting live
in the new `booking-ledger-pending-charge.ts`, and each door gains only its
pre-transaction context read and one call.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 554
reason: the switch is a binding door: its pre-transaction context read and the
  R01 call inside its locked transaction, after the payment upsert.

file: src/lib/booking-exception-approval.ts
lines: 1246
reason: the approval hands the create the journal context it already resolved
  for the batch executor, before its transaction.

