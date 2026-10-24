# File-size allowances for #3953

A change's card capture that no supplementary invoice waited on is recorded
against the Xero invoice that bills it by a new outbox row. Its logic lives in
new modules (`additional-capture-xero-receipt.ts`, its enqueue, payload, link
and repair-finding modules); each file below only gains the line or two that
wires it in, at the one place that question is already answered for every
other queue type.

file: src/lib/stripe-webhook-service.ts
lines: 1776
reason: the charge-refunded handler is the one place a Stripe refund of a
  single capture queues its refund note, so it alone can name the invoice that
  capture's own receipt paid; one read through the receipt-link leaf and the
  note's existing `creditsInvoiceId` option.

file: src/lib/xero-booking-invoices.ts
lines: 1658
reason: the primary invoice create is the one writer of the figures stored
  with its link; it now passes through which captures its cash figure counted,
  read in its existing snapshot. One destructured name and one field.

file: src/lib/xero-booking-repair-classify.ts
lines: 2396
reason: the classifier is where every booking's findings are gathered before
  its summary is built; the new finding lives in its own module and this adds
  only its import, the one call beside the summary, and (review round 1) the
  one payload field that raises a change's missing invoice unpaid where its
  capture's receipt already records the payment, inside the arm that builds
  that action.

file: src/lib/xero-operation-outbox.ts
lines: 3354
reason: the outbox dispatch chain routes every queue type to its worker, and
  its census requires one branch per member of `XERO_OUTBOX_QUEUE_TYPES`; the
  new type's branch, its import and its constant. Review round 1: the
  supplementary enqueue's payload is written in this one place, so the #3980
  gap invoice's mark and the captures it pays itself from ride its one
  options type, forwarded field by field like the others; and (round 3) the
  pending scan leaves a waiting receipt out until its recheck, beside the
  billed-offset note's own spacing, through one import from the receipt's
  gate module. Round 6: the supplementary enqueue's decide is the one place,
  under the anchor's lock, that can see a receipt already recording the
  change's capture, so it raises the invoice unpaid there - one read through
  the receipt-link module and the payload's recordPayment taking it. Round 7:
  where the booking has a change capture no change can be read from, that
  same decide first takes the booking's lock, which such a capture's receipt
  decides under - one read and one lock call.

file: src/lib/xero-operation-retry.ts
lines: 2078
reason: the retry module decides, per queue type, whether a row may be
  retried and sends outbox-run rows back on their own row; the receipt joins
  that same-row requeue (its stored payment kept) in the two places every
  other outbox-run type is answered. Round 9: the inline replay of a change's
  supplementary invoice is the one place an officer's Retry decides whether
  it records a payment, so it asks once more, under the change's anchor lock,
  whether a capture's receipt now records it - one import and one call.
  Round 11: the late card charge's change invoice requeue asks the same
  question before it requeues, and keeps the stored payload rather than
  writing back the one it read.
