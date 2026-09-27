# File-size allowances for #3638 — card first, then bank

The new logic was split rather than allowed for wherever it could stand
alone: the two settlement conflicts and their shared record live in
`src/lib/xero-inbound/settlement-conflicts.ts`, the "is this card intent
dead" questions in `src/lib/card-intent-retirement.ts`, the locked intent
attach both card doors share in `src/lib/card-intent-attach.ts`, and the new
admin alert in `src/lib/email/admin-alerts-settlement.ts`.
These files still grow. Three more carry #3638's growth in #3535's fragment
(`3535-ib-hold-expiry-clearing-note.md`), because both changes reach main in
one epic and the gate takes one allowance per file: `booking-cancel.ts`,
`xero-booking-repair-classify.ts` and `invoice-paid-effects.ts`.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 550
reason: the refusal has to run in this route, before its locked transaction,
  so a refused switch writes nothing and raises no invoice; the under-lock
  check that the payment still points at the intent it retired has to sit
  inside that same transaction, and its retryable refusal has its own message.
  The retirement rule itself is shared (`card-intent-retirement.ts`).

file: src/app/api/payments/create-payment-intent/route.ts
lines: 834
reason: the reverse race closes where the intent is attached. The attach
  itself moved into the shared `attachMintedCardIntent`; what stays is the
  call, the refusal responses for an Internet Banking or no-longer-payable
  booking (one body for both Internet Banking refusals) and the comment
  saying why.

file: src/lib/booking-delete.ts
lines: 738
reason: the soft delete reads the same "is this intent dead" predicate as
  booking cancellation, so an intent already cancelled at Stripe has its row
  closed here too: the import and a three-line comment.

payment-recovery.ts needs no allowance once #3640 composes with this change: its
superseded-payment refund moved onto the one card-refund writer, and the file is
shorter than its base.

file: src/lib/email-message-registry.ts
lines: 2111
reason: the new admin alert's registry entries — admin audience, delivery
  lock, required tokens, trigger metadata, approved token and preview value —
  each belong in the table that already holds every other template's, with
  the comment saying why it is locked.
