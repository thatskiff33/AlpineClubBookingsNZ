# File-size allowances for #4998 (#4516, Ledger M4d)

A hand-back's refund debt (R05) has to post in the same transaction, under the
same locks, as the task it records, so each door that raises or releases a
hand-back gains a line or a few beside the write it already makes. Moving those
lines elsewhere would separate the journal post from the write and the locks it
depends on.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 760
reason: a released approval withdraws its bank hand-back's debt beside the release, under the same Payment row.

file: src/lib/booking-batch-modification-service.ts
lines: 2763
reason: one argument passes the edit's journal context to the hand-back raise it already calls.

file: src/lib/booking-cancel.ts
lines: 2874
reason: the paid cancel's hand-back debt posts beside its task, under the claim's lock(1).

file: src/lib/booking-date-modification-service.ts
lines: 2264
reason: one argument passes the edit's journal context to the hand-back raise it already calls.

file: src/lib/booking-guest-removal-service.ts
lines: 1254
reason: one argument passes the removal's journal context to the hand-back raise it already calls.

file: src/lib/payment-transactions.ts
lines: 1865
reason: the local allocation returns the receipts it consumed, which fund the hand-back's payment and nothing else.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2109
reason: an organisation's late cash posts its hand-back debt beside the task, under the delivery's lock(1).
