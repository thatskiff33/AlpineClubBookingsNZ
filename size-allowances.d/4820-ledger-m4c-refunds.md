# File-size allowances for #4516 (Ledger M4c card refunds)

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 747
reason: the appeal's R05 must post inside the claim's lock(1) and Payment-row transaction, and its withdrawal inside the release_claim transaction; moving either out would split those transactions' lock order across files.

file: src/lib/booking-batch-modification-service.ts
lines: 2762
reason: one argument passes the edit's card refund to the R05 posted beside its R02, inside the edit's transaction.

file: src/lib/booking-cancel.ts
lines: 2872
reason: the paid cancel's R05 posts beside its R04 inside the claim transaction, and its sender names that debt; both belong to the existing locked flow.

file: src/lib/booking-date-modification-service.ts
lines: 2268
reason: one argument passes the edit's card refund to the R05 posted beside its R02, inside the edit's transaction.

file: src/lib/booking-guest-removal-service.ts
lines: 1253
reason: one argument passes the edit's card refund to the R05 posted beside its R02, inside the edit's transaction.

file: src/lib/payment-reconciliation.ts
lines: 2881
reason: W1 posts a returned capture's R05 in the same transaction as its settle and R06, and its two senders name that debt; the hook must sit inside that transaction.

file: src/lib/payment-transactions.ts
lines: 1861
reason: the one card refund sender reserves each slice before Stripe is asked, and the one cash writer posts R12/R13 inside its own Payment-row transaction; the reservation step's root-client transaction shares this module's Payment-row budget and refund error type, so splitting it out would create an import cycle.

file: src/lib/stripe-webhook-service.ts
lines: 1787
reason: the automatic late-capture refund names its deferred debt and holds the capture when the journal refuses its reservation, instead of rethrowing for Stripe's redelivery; the catch belongs beside the call it guards.
