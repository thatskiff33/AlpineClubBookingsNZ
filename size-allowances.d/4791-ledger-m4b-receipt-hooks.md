# File-size allowances for #4516 (PR #4791, Ledger M4b receipts)

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 954
reason: the receipt context must be resolved before the route's locks and passed into the existing settle; moving the route's settle body out would split one transaction's lock order across files.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 355
reason: the receipt context must be resolved before the route's locks and handed to the existing settle call; a two-line threading change does not justify splitting the route.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 679
reason: the capture instant and receipt context are threaded into the existing settle; splitting the route would separate them from the Stripe call they follow.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 922
reason: the receipt context is threaded into the existing settle call; a two-line change does not justify splitting the route.

file: src/lib/booking-cancel.ts
lines: 2864
reason: the cancel's part-payment path passes the receipt context its writer now needs; one line inside an existing locked flow.

file: src/lib/cron-confirm-pending.ts
lines: 2046
reason: the cron resolves the receipt context before its locks and passes it to the settle; the lines belong beside the lock they precede.

file: src/lib/payment-reconciliation.ts
lines: 2869
reason: the settle posts its receipt in the same transaction as its legacy write (INV-LOCK); the hook call and its collect decision must sit inside that transaction, so they cannot move to another module without splitting the transaction.

file: src/lib/payment-recovery.ts
lines: 3627
reason: the superseded-capture flip becomes a status-guarded claim under the Payment row with its receipt in the same transaction; the guard and the post must stay inside that one transaction.

file: src/lib/payment-transactions.ts
lines: 1763
reason: the additional-capture writer decides collect under the Payment row and posts the receipt in the same transaction; the decision has to stay beside the lock it reads under.

file: src/lib/stripe-webhook-service.ts
lines: 1774
reason: the webhook resolves receipt context before taking the Payment row and posts held receipts for late and cancelled-primary captures in that transaction.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2104
reason: the Xero receipt is posted only after the body completes normally, from the rows this delivery moved to captured; the selection must be read under the same Payment row before its update.

