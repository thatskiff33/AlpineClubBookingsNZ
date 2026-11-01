file: src/lib/payment-recovery.ts
lines: 3571
reason: the preflight rule lives in its own module; these call sites must precede both charge-backed executors and the hold must use the existing guarded failure transition rather than creating another status writer. The no-plan fallback reads the executor's own row filter, and a failed hold audit is logged rather than abandoning the batch.

file: src/lib/payment-transactions.ts
lines: 1719
reason: capturedStripeTransactions is the one filter both the refund executor and the #4359 preflight read, so the check can never cover a row the executor would not refund; it belongs beside isStripeTransaction, which it composes.
