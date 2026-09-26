# File-size allowances for #3639 — a cancelled booking's money is not re-decided

Both Stripe webhook late-capture handlers now ask what the
cancellation already settled before they refund. The rule itself lives in
`src/lib/cancellation-settled-money.ts` and the reads it needs in
`src/lib/cancelled-booking-late-capture.ts`; what stays in the handlers is one
call each, its early return, and the provenance mark on the primary's own write.

file: src/lib/stripe-webhook-service.ts
lines: 1803
reason: the question has to be asked inside BOTH late-capture handlers,
  before their first write and their refund, and the provenance constant has
  to be the one the primary handler writes; the rule, its reads and its audit
  record already sit in their own modules, so what remains is two call sites
  and their early returns.

The owner's added requirement (26 Sep 2026): a club setting to refund a
genuine late capture automatically or have a treasurer approve it. The rule,
the raise, the completion route and its executor live in the new
`src/lib/late-capture-refund-approval.ts`; the Xero correction the three refund
paths share moved out of the webhook into `late-capture-refund-credit-note.ts`,
which is why the webhook file shrank. What remains below are the seams.

file: src/lib/payment-recovery.ts
lines: 3228
reason: the approval's refund debt has to be persisted through the module's
  private ledger-recovery writer, exactly as the edit-review debt beside it is,
  and the replay has to hand a late-capture prefix to the Xero correction; the
  correction itself and the close live outside this file.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2079
reason: the finance queue has to say, on the row and in the dialog, that this
  item refunds the card through Stripe or keeps the money; every sentence is a
  per-kind branch of the existing copy functions, which is where each other
  kind's wording already lives.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1173
reason: the setting travels with the club's other booking defaults, so it is
  one field and one constraint in that entity's declaration.

file: src/lib/deleted-booking-modification-payment.ts
lines: 868
reason: the confirm route's #2700 raise must see the webhook's approval task
  for the same capture, so its duplicate check matches the approval key too.
