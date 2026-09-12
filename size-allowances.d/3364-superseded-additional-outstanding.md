# File-size allowances for #3364 (issue #3340 — the superseded extra)

Four already-over-budget modules grow here. None is restructured by this change,
and in every case the split that would avoid the growth is worse than the growth.

## `src/lib/payment-recovery.ts`

Seventy lines: `runPaymentRecoveryOperationNow`, and the call that makes a
supersede refund visible.

The runner exists because a superseded `PaymentIntent` used to stay confirmable
until the five-minute recovery cron reached it — measured at 4 minutes 5 seconds
in the live case, and a member's card confirm landed inside that window, charging
$65 against an intent the club had already replaced while the page read $300. The
mint now drains its own cancellation before it hands the new client secret back.

**It could not be a copy of the cancel call at the mint site, and it cannot live
anywhere else.** Cancelling a Stripe intent has a genuinely hard case — Stripe can
move an intent from cancellable to `succeeded` between the retrieve and the
cancel, which has to hand off to a refund rather than mark the transaction FAILED
— and that reasoning already lives in `processCancelPaymentIntentOperation` here.
A second copy of it at the mint site is the two-implementations-of-one-rule defect
this repository keeps re-finding (`INV-SSOT-001`). Lifting the runner into its own
module instead would mean EXPORTING three of this module's internals
(`claimPaymentRecoveryOperation`, `processPaymentRecoveryOperation`,
`failPaymentRecoveryOperation`), which widens the module's public surface to
narrow its line count — a worse trade on a file whose whole job is to be the one
place a recovery operation is claimed, run and failed.

The remaining thirteen lines are the call into `reportSupersededPaymentRefund`
and the comment saying why it sits between the reconcile and the completion: the
"still owing" figure it quotes has to be the post-refund one, and an operation
that closes without its notice going out is the silence #3340 exists to end. The
epilogue ITSELF is a new module (`src/lib/superseded-additional-refund.ts`), so
the audit row, the booking event, the member email and the admin alert are not
what grows this file.

file: src/lib/payment-recovery.ts
lines: 2997
reason: seventy lines on a 2927-line module that is not restructured here. Most
  of them are `runPaymentRecoveryOperationNow`, which lets the ask-minting path
  cancel a superseded PaymentIntent synchronously instead of leaving it
  confirmable for up to five minutes. It has to live beside the processor it
  reuses: copying the succeeded-race handling to the mint site is the duplicate
  rule this repository keeps re-finding, and moving it out would require
  exporting three module internals to save lines on the one file whose job is to
  own them. The epilogue that records and announces the refund is its own new
  module; only its call site is here.

## `src/lib/email/booking.ts`

Thirty-eight lines: `sendSupersededPaymentRefundedEmail` and its docblock.

This is the one home for booking-scoped member mail, and every property that
makes the new notice correct comes from being in it — the shared
`bookingOwnerEmailContext`, so the per-booking "No emails" switch withholds it
like every other booking mail, and the shared `sendEmail` with its template
registry and retry lifecycle. A separate module for one sender would put the
first booking mail outside the inventory that `booking-email-suppression.ts` and
`booking-email-template-contract.ts` classify from, which is the mechanism that
stopped a booking mail escaping that switch in the first place.

Splitting this file by message family is a real and worthwhile job — it is
nineteen senders — but it is a refactor of its own, and doing it inside a money
fix would bury the money fix's diff.

file: src/lib/email/booking.ts
lines: 1638
reason: one new member notice on a 1600-line module that is not restructured
  here. A supersede refund used to reach the member as nothing but the payment
  provider's own receipt; this sender is the explanation, naming what was
  refunded and what is still owing. It belongs beside its siblings because the
  shared booking context is what makes the per-booking "No emails" switch apply
  to it, and because the suppression and token-contract inventories classify
  from this module. Splitting nineteen senders by family is a genuine job and an
  unrelated one.

## `src/app/(admin)/admin/payments/page.tsx`

Fourteen lines on the payments board, six of them the net-of-refunds figure and
its explanatory sub-line, the rest the comment saying which defect this was.

The column rendered GROSS beside a "Partially refunded" chip, so a $130 capture
with $65 refunded read as "paid $130" — and a booking officer sized the
outstanding balance at `430 - 130 = 300` when the truth was `430 - 65 = 365`.
That is the same gross-versus-net error as the ask-sizing defect this pull
request fixes, rendered rather than arithmetized, and **both wrong numbers agreed
with each other**, which is why the $300 looked right to everyone who saw it. The
comment is what stops the next reader "simplifying" it back.

This screen is 1305 lines of one admin page and was already far over its
250-line route budget before this change touched it. Splitting it is a real job
and an unrelated one: this is a money fix, and re-cutting the payments board
inside it would bury the money fix's diff and put the club's main finance screen
at risk for a reason that has nothing to do with the defect.

file: src/app/(admin)/admin/payments/page.tsx
lines: 1319
reason: fourteen lines on a 1305-line admin screen that is not restructured here.
  Six are the net-of-refunds figure with the gross and the refund printed
  underneath; the rest record that this column's gross figure is what led an
  officer to size an outstanding balance at 430-130 rather than 430-65 — the same
  error as the ask-sizing defect, and one where the two wrong numbers agreed with
  each other. Splitting the payments board is a genuine job and an unrelated one.

## `src/lib/email-message-registry.ts`

Eighteen lines: two registry entries — the member notice and the operator alert
for a supersede refund — and the `{{amountOwing}}` token both bodies use.

This file IS the registry: one entry per message, in one place, which is what
`email-message-token-contract.ts` and the admin editor's validator classify from.
An entry cannot live anywhere else without leaving the message unregistered, and
an unregistered message is one an admin cannot edit and no contract test sees.
The token is its own approved name rather than a second use of `{{amount}}`
deliberately: the refunded amount and the corrected amount owing appear in the
same body, and an override that confused them would tell a member the wrong
balance.

file: src/lib/email-message-registry.ts
lines: 2072
reason: eighteen lines on a 2054-line registry that is not restructured here —
  two message entries and one approved token. The registry is by construction one
  entry per message in one file, and it is what the token contract and the admin
  editor's validator classify from, so an entry has nowhere else to go. The
  separate `{{amountOwing}}` token keeps the refund and the remaining balance from
  collapsing into one figure in an admin's override.
