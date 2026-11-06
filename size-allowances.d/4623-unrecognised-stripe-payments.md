# File-size allowances for #4532

file: src/lib/stripe-webhook-service.ts
lines: 1758
reason: the payment_intent.succeeded dispatcher gains one first branch that
  hands a payment the app did not create to its own module
  (unrecognised-stripe-payment.ts); the branch belongs beside the dispatch it
  precedes, and everything else lives in the new module.

