# File-size allowances for #3639 — a cancelled booking's money is not re-decided

Both Stripe webhook late-capture handlers now ask what the
cancellation already settled before they refund. The rule itself lives in
`src/lib/cancellation-settled-money.ts` and the reads it needs in
`src/lib/cancelled-booking-late-capture.ts`; what stays in the handlers is one
call each, its early return, and the provenance mark on the primary's own write.

file: src/lib/payment-recovery.ts
lines: 3239
reason: the approval's refund debt has to be persisted through the module's
  private ledger-recovery writer, the superseded-intent hand-off has to ask the
  late-capture hold before it refunds a change payment on a cancelled booking
  (the hold itself lives in `late-capture-refund-hold.ts`), exactly as the edit-review debt beside it is,
  and the replay has to hand a late-capture prefix to the Xero correction; the
  correction itself and the close live outside this file.
  Re-measured at the #3635 main sync, composed with main's #3567 and #3589 changes.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2132
reason: the finance queue has to say, on the row and in the dialog, that this
  item refunds the card through Stripe or keeps the money; every sentence is a
  per-kind branch of the existing copy functions, which is where each other
  kind's wording already lives. #3643 (same epic, one file one allowance) adds
  its part-payment review the same way: a marker predicate, its paragraph, and
  one branch in each copy function, beside the late-capture ones. Its
  decision-3 round adds the review row's one optional payload field and the
  line that renders the sync's Xero-paid note; the line itself lives in
  `part-payment-review-xero-paid-line.tsx`.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1173
reason: the setting travels with the club's other booking defaults, so it is
  one field and one constraint in that entity's declaration.

file: src/lib/deleted-booking-modification-payment.ts
lines: 873
reason: the confirm route's #2700 raise must see the webhook's approval task
  for the same capture, so its duplicate check matches the approval marker too.

The review round (27 Sep 2026) moved three more files, each by the minimum.

file: src/lib/member-credit.ts
lines: 1033
reason: one import, so the cancellation credit's description comes from the
  one builder its reader matches on (`cancellationCreditDescription`).
  Re-measured at the #3635 main sync, composed with main's #3589 operator money messages.

file: src/lib/xero-credit-notes.ts
lines: 1183
reason: one import, for the same shared description builder. #3635 (same
  epic) lets the refund note answer a kept late capture's own invoice when the
  payment has no primary one: one import and the fallback at the gate; the
  lookup lives in `late-capture-xero-receipt.ts`. Composed with the
  resolved-in-Xero fence, the execution-time cap reads the one coverage sum
  and refuses an unreadable resolved note, beside the cap it corrects; both
  live in `xero-resolved-in-xero-fences.ts`. Round 3 caps against the
  note-eligible cash (`refund-note-eligible-cash.ts`), and a late capture's
  note names that capture's own receipt, is skipped without one the app
  recorded, and carries its refund's day on the note and its payment; the
  receipt rule lives in `late-capture-xero-receipt.ts`, and what stays is the
  branch at the one place the note chooses its reference.
