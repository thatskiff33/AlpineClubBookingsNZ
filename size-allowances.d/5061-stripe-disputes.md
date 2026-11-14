# File-size allowances for #5061 (Stripe disputes, #4911)

Seven already-over-budget files grow. Each gains the dispute hold at a door
that already lives in it, or a row in a registry that is the one list of its
kind. The new logic itself sits in its own modules (`stripe-dispute.ts`,
`stripe-dispute-hold.ts`, `stripe-dispute-note.ts`, `stripe-charge.ts`), and
the four files this change would otherwise have taken over budget for the
first time were reduced instead.

file: src/lib/booking-cancel.ts
lines: 2880
reason: the paid cancel reads the dispute hold inside its claim, under the
  locks it already holds (`INV-LOCK-001`), and its hand-back task, audit row,
  member sentence and result say why. Each line sits in the branch it changes;
  moving them out would split the claim's one decision across two files.

file: src/lib/email-message-registry.ts
lines: 2503
reason: the dispute alert's rows in the registry's own tables - admin
  template, locked delivery, required tokens, subject token, trigger
  metadata, sample values and approved tokens. The registry tests hold each
  table as the single list of its kind.

file: src/lib/email-message-renderer.ts
lines: 964
reason: one entry in the required-subject-token guidance table, beside the
  other templates' entries the renderer reads from that table.

file: src/lib/payment-recovery.ts
lines: 3634
reason: the superseded-payment recovery asks the dispute hold before it
  reserves its request, two lines in the step that reserves; elsewhere the
  read would no longer sit before the reservation it must precede.

file: src/lib/payment-transactions.ts
lines: 1873
reason: refundPaymentTransactions refuses a disputed capture for every slice
  before any is reserved or sent. The check must sit between planning the
  slices and reserving them, which is inside this function.

file: src/lib/stripe-webhook-service.ts
lines: 1804
reason: the four charge.dispute.* cases in the one dispatcher the event
  census reads, and the late-capture handlers' hold of a refund refused for a
  dispute, beside their existing holds for the other refusals.

file: src/app/(admin)/admin/finance/payments/page.tsx
lines: 1439
reason: the dispute marker chip in the payment row's existing chip list,
  beside the other status chips it is read with; the row type gains the
  field the service returns. The chips themselves render in DisputeChips,
  outside the page function.

## Function-length ratchet (#4927)

Four already-over-limit functions grow. The ratchet arrived from `main`
after this change was written; the page chip was moved out to keep
`PaymentsPage` to one line, and the rest stay where they are for the reasons
below.

function: src/lib/booking-cancel.ts#performBookingCancellation
lines: 2121
reason: the dispute hold is read inside the paid cancel's claim, under the
  locks it already holds (`INV-LOCK-001`), and the hand-back reason, audit
  details, member sentence and result branch on it in the steps that already
  make those decisions. Lifting them out would split the claim's one decision
  across functions without the locks in view.

function: src/lib/email-message-registry.ts#sampleValue
lines: 406
reason: the dispute alert's sample tokens are cases in the one sample-value
  switch every template's preview reads; a second lookup for one template
  would be the parallel list this registry exists to prevent.

function: src/lib/admin-payments-service.ts#listAdminPayments
lines: 364
reason: one batched dispute read for the page's bookings and the field on
  each row it returns; the read has to sit after the page's rows are loaded
  and before they are shaped, which is inside this function.

function: src/app/(admin)/admin/finance/payments/page.tsx#PaymentsPage
lines: 1024
reason: one line, the DisputeChips element in the row's existing chip list;
  the chips render in their own component.
