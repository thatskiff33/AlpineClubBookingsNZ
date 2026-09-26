# File-size allowances for #3639 — a cancelled booking's money is not re-decided

The Stripe webhook's primary late-capture handler now asks what the
cancellation already settled before it refunds. The rule itself lives in
`src/lib/cancellation-settled-money.ts` and the reads it needs in
`src/lib/cancelled-booking-late-capture.ts`; what stays in the handler is the
one call, its acknowledgement, and the provenance mark on its own write.

file: src/lib/stripe-webhook-service.ts
lines: 1814
reason: the question has to be asked inside the handler, before its first
  write and its refund, and the provenance constant has to be the one the
  handler writes; the rule and its reads already sit in their own modules, so
  what remains is the call site and its early return.
