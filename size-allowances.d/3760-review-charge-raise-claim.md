# File-size allowances for #3760 (issue #3402)

The review round on the review-charge raise claim found two places the claim's
"no lost share" guarantee leaned on code that could not deliver it: the edit's
one recovery row was never reopened once an earlier replay had closed it, and
the raise's row write could revert a status a payment webhook had just written.
Both fixes write into the module that owns the row they touch.

The recovery row's lifecycle rules (when a replay may close it, the fenced close,
the re-arm) were split out to `src/lib/edit-financial-review-charge-recovery.ts`
rather than allowed. What stays below is the part that cannot move without an
import cycle or a second home for one write.

file: src/lib/payment-recovery.ts
lines: 3281
reason: `enqueueEditFinancialReviewChargeRecovery` wraps this module's own
  `enqueueAdditionalPaymentIntentRecovery` and is the one home for the edit's two
  recovery keys; moving it beside the re-arm would make that module import this
  one while this one imports it. The remaining lines are the imports and the two
  call sites in the replay.

file: src/lib/payment-transactions.ts
lines: 1548
reason: `writeRaisedAdditionalRequestAmount` is a `PaymentTransaction` write that
  reconciles the payment's aggregates, and this module is the one home for both
  (`INV-SSOT`). A second module writing ADDITIONAL rows would be a second place to
  forget the status fence.
