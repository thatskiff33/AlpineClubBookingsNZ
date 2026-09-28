# File-size allowances for #3641 — a waiting invoice outlives age and a decline while payable

The waiting-invoice reaper and the late-capture release now live in their own
modules (`xero-waiting-invoice-reaper.ts`, `xero-supplementary-invoice-late-capture.ts`),
both inside budget, and `xero-operation-outbox.ts` is shorter than on the base
ref. The one over-budget file that grows is the Stripe webhook service.

file: src/lib/stripe-webhook-service.ts
lines: 1805
reason: the additional-payment handler's CANCELLED check now calls the one
  exported refund predicate (`isLateCaptureRefundedBookingStatus`) that the
  late-capture Xero release shares, which costs its import and a one-line
  pointer; restating the status test inline is the two-spellings defect the
  review round removed, and the handler cannot move for one line. #3639
  (same epic, one file one allowance) asks what the cancellation already
  settled, and whether the club holds late captures for a treasurer, inside
  both late-capture handlers before their refund; the rule, the hold and the
  shared Xero correction live in their own modules.
