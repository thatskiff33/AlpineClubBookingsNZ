# File-size allowances for #3364 (issue #3340 — the superseded extra)

Five already-over-budget modules grow here. None is restructured by this change,
and in every case the split that would avoid the growth is worse than the growth.

## `src/lib/payment-recovery.ts`

A hundred and ninety-six lines: `runPaymentRecoveryOperationNow`, the call that
makes a supersede refund visible, and the fix round's three corrections to this
file.

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

Thirteen more are the call into `reportSupersededPaymentRefund` and the comment
saying why it sits where it does: the "still owing" figure it quotes has to be
the post-refund one, and an operation that closes without its notice going out is
the silence #3340 exists to end. The epilogue ITSELF is a new module
(`src/lib/superseded-additional-refund.ts`), so the audit row, the booking event,
the member email and the admin alert are not what grows this file.

The fix round adds the rest, and all of it is reasoning rather than machinery.
The replay now RE-DERIVES the ask through `sizeAdditionalAskCents` instead of
replaying the figure frozen on the row, because since #3340 the ask is a fact
about a moment rather than about an edit and a frozen moment can overcharge a
member who paid the earlier ask while the mint was down; that needs its own
Stripe idempotency key when the figure moves, and the comment explaining why a
reused key would otherwise become a permanent `idempotency_error` is longer than
the expression it guards. The supersede-refund epilogue is fenced on the
completion claim so a partially-applied replay cannot send a second "we have
refunded you" email. And a declined immediate run is logged rather than returned
silently. Every one of those lines is beside the processor whose behaviour it
changes; none of it is a unit anything else could import.

file: src/lib/email/booking.ts
lines: 1643
reason: one new member notice on a 1600-line module that is not restructured
  here. A supersede refund used to reach the member as nothing but the payment
  provider's own receipt; this sender is the explanation, naming what was
  refunded and what is still owing. It belongs beside its siblings because the
  shared booking context is what makes the per-booking "No emails" switch apply
  to it, and because the suppression and token-contract inventories classify
  from this module. Splitting nineteen senders by family is a genuine job and an
  unrelated one.

## `src/app/(admin)/admin/payments/page.tsx`

Twenty-one lines on the payments board: six the net-of-refunds figure and its
explanatory sub-line, the rest comments saying which defect this was and which
quantity each control now names.

The column rendered GROSS beside a "Partially refunded" chip, so a $130 capture
with $65 refunded read as "paid $130" — and a booking officer sized the
outstanding balance at `430 - 130 = 300` when the truth was `430 - 65 = 365`.
That is the same gross-versus-net error as the ask-sizing defect this pull
request fixes, rendered rather than arithmetized, and **both wrong numbers agreed
with each other**, which is why the $300 looked right to everyone who saw it. The
comment is what stops the next reader "simplifying" it back.

The fix round added the remaining seven, and they are labels and a comment
rather than behaviour: the column header says "Amount (net)", the filter boxes
say "Gross amount", and the comment records why the two are different quantities
— the filter is a `where` on a database column and a net expression cannot be
one. The board contradicting itself about which figure it meant is what the
review found.

This screen is 1305 lines of one admin page and was already far over its
250-line route budget before this change touched it. Splitting it is a real job
and an unrelated one: this is a money fix, and re-cutting the payments board
inside it would bury the money fix's diff and put the club's main finance screen
at risk for a reason that has nothing to do with the defect.

file: src/app/(admin)/admin/payments/page.tsx
lines: 1322
reason: twenty-one lines on a 1305-line admin screen that is not restructured
  here. Six are the net-of-refunds figure with the gross and the refund printed
  underneath; the rest record that this column's gross figure is what led an
  officer to size an outstanding balance at 430-130 rather than 430-65 — the same
  error as the ask-sizing defect, and one where the two wrong numbers agreed with
  each other — and label which control names which quantity, because the column
  is net and the filter behind it can only be gross. Splitting the payments board
  is a genuine job and an unrelated one.

## `src/lib/email-message-registry.ts`

Twenty-three lines: two registry entries — the member notice and the operator
alert for a supersede refund — and the two approved tokens their bodies use.

This file IS the registry: one entry per message, in one place, which is what
`email-message-token-contract.ts` and the admin editor's validator classify from.
An entry cannot live anywhere else without leaving the message unregistered, and
an unregistered message is one an admin cannot edit and no contract test sees.
`{{amountOwing}}` is its own approved name rather than a second use of
`{{amount}}` deliberately: the refunded amount and the corrected amount owing
appear in the same body, and an override that confused them would tell a member
the wrong balance. `{{owingSentence}}` is the fix round's: the editable default
said "Still owing on this booking: {{amountOwing}}" unconditionally while the
coded template branches to "Nothing further is owing" at zero, so a club that had
touched the editor sent "Still owing: $0.00" as reassurance. One function now
composes that sentence for both surfaces.

file: src/lib/email-message-registry.ts
lines: 2077
reason: twenty-three lines on a 2054-line registry that is not restructured here —
  two message entries and two approved tokens. The registry is by construction one
  entry per message in one file, and it is what the token contract and the admin
  editor's validator classify from, so an entry has nowhere else to go. The
  separate `{{amountOwing}}` token keeps the refund and the remaining balance from
  collapsing into one figure in an admin's override.

## `src/app/(authenticated)/bookings/[id]/page.tsx`

One line, and it is a line that REMOVES a duplicate rule.

The member's payment-card gate carried its own hand-written copy of the money
half of the owed test (`additionalAmountCents > 0 && additionalPaymentStatus !==
"SUCCEEDED"`). #3340 is a defect about one figure being decided in more than one
place, so leaving a fourth copy of the predicate that decides whether an extra is
still owed — on the very door the ask opens — would be shipping the fix and its
own counter-example together. The gate now calls
`isAdditionalAmountUncollected`, the one predicate
(`src/lib/additional-payment-chase.ts`), which is what the chase, the ask sizing
and the ledger census all call.

The net change is the import: two hand-written conditions became one call plus a
one-line comment. This 2792-line page is not restructured here, and splitting it
is an unrelated job.

