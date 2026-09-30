# File-size allowances for #3641 — a waiting invoice outlives age and a decline while payable

The waiting-invoice reaper and the late-capture release now live in their own
modules (`xero-waiting-invoice-reaper.ts`, `xero-supplementary-invoice-late-capture.ts`),
both inside budget, and `xero-operation-outbox.ts` is shorter than on the base
ref. The one over-budget file that grows is the Stripe webhook service.

file: src/lib/stripe-webhook-service.ts
lines: 1816
reason: the additional-payment handler's CANCELLED check now calls the one
  exported refund predicate (`isLateCaptureRefundedBookingStatus`) that the
  late-capture Xero release shares, which costs its import and a one-line
  pointer; restating the status test inline is the two-spellings defect the
  review round removed, and the handler cannot move for one line. #3639
  (same epic, one file one allowance) asks what the cancellation already
  settled, and whether the club holds late captures for a treasurer, inside
  both late-capture handlers before their refund; the rule, the hold and the
  shared Xero correction live in their own modules. #3635 (same epic) makes
  `charge.refunded` ask whether a task-owned late capture has a Xero receipt
  yet before noting its refund: one import and the condition; the rule lives
  in `late-capture-xero-receipt.ts`. Its round-3 fix routes a late capture's
  refund to the per-capture note (`noteLateCaptureRefunds`) instead of the
  payment-wide delta, which is the refund note the handler already queues;
  what stays is the branch and a four-line intent test beside the handler.
