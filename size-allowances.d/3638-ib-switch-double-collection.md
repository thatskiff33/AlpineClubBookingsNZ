# File-size allowances for #3638 — card first, then bank

The new logic was split rather than allowed for wherever it could stand
alone: the two settlement conflicts and their shared record live in
`src/lib/xero-inbound/settlement-conflicts.ts`, the "is this card intent
dead" questions in `src/lib/card-intent-retirement.ts`, the locked intent
attach both card doors share in `src/lib/card-intent-attach.ts`, and the new
admin alert in `src/lib/email/admin-alerts-settlement.ts`.
These files still grow.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 550
reason: the refusal has to run in this route, before its locked transaction,
  so a refused switch writes nothing and raises no invoice; the under-lock
  check that the payment still points at the intent it retired has to sit
  inside that same transaction, and its retryable refusal has its own message.
  The retirement rule itself is shared (`card-intent-retirement.ts`).

file: src/lib/xero-booking-repair-classify.ts
lines: 1673
reason: one predicate call so the repair tool's late-capture arm no longer
  reads an admin-only settlement marker as a recorded refund decision, plus
  its import and the comment saying why.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 834
reason: the reverse race closes where the intent is attached. The attach
  itself moved into the shared `attachMintedCardIntent`; what stays is the
  call, the refusal responses for an Internet Banking or no-longer-payable
  booking (one body for both Internet Banking refusals) and the comment
  saying why.

file: src/lib/booking-cancel.ts
lines: 2540
reason: the cancel helper marks the local row FAILED only when Stripe
  confirms the intent is dead (the shared predicate), with the warning and
  the comment that say why; it is the one helper both cancel branches call.

file: src/lib/booking-delete.ts
lines: 738
reason: the soft delete reads the same "is this intent dead" predicate as
  booking cancellation, so an intent already cancelled at Stripe has its row
  closed here too: the import and a three-line comment.

file: src/lib/payment-recovery.ts
lines: 3185
reason: one import; the superseded-intent cancel now reads the shared
  predicate instead of spelling the rule inline.

file: src/lib/email-message-registry.ts
lines: 2111
reason: the new admin alert's registry entries — admin audience, delivery
  lock, required tokens, trigger metadata, approved token and preview value —
  each belong in the table that already holds every other template's, with
  the comment saying why it is locked.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1718
reason: the second-instrument marker has to be written inside this settle
  transaction, beside the bank receipt it describes, so the two commit or roll
  back together; the call sits at the two points the loop returns the
  conflict. The detection, the marker writer and the alert all live in
  `settlement-conflicts.ts`, which is where the rest of the growth went.
