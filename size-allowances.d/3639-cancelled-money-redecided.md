# File-size allowances for #3639 — a cancelled booking's money is not re-decided

Both Stripe webhook late-capture handlers now ask what the
cancellation already settled before they refund. The rule itself lives in
`src/lib/cancellation-settled-money.ts` and the reads it needs in
`src/lib/cancelled-booking-late-capture.ts`; what stays in the handlers is one
call each, its early return, and the provenance mark on the primary's own write.

file: src/lib/stripe-webhook-service.ts
lines: 1827
reason: the question has to be asked inside BOTH late-capture handlers,
  before their first write and their refund, and the provenance constant has
  to be the one the primary handler writes; the rule, its reads and its audit
  record already sit in their own modules, so what remains is two call sites
  and their early returns.
