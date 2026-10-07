# File-size allowances for #3750

Approving a locked-period change request on a finished stay executes it
through the canonical batch edit, under one service argument. The executor, its
fee rule, its call guard and the officer's decision handling live in new modules
(`booking-change-request-execution.ts`, `booking-finished-stay-correction.ts`,
`booking-change-request-admin-decision.ts`); only the lines that must sit at the
decision points they change are added to the two files below.

file: src/lib/booking-batch-modification-service.ts
lines: 2888
reason: the finished-stay mode changes four decisions inside the one
  transaction - the edit-policy window, the capacity confirm, the change fee and
  refund tier day (including a swap's same-day fee on the removed portion,
  settled once), and the Xero lock-date envelope - each at the line that
  already makes that decision for every other edit. Moving them out would put
  the rule and its exception in different files, which is how a second pricing
  home starts; the guard and the fee rule themselves already live in
  booking-finished-stay-correction.ts.

file: src/lib/booking-modify-plan.ts
lines: 3270
reason: the no-active-season refusal sentence becomes one exported constant
  the two throw sites use, so the finished-stay approval can recognise it
  without matching the sentence by hand (INV-SSOT-001). The constant belongs
  beside the throws that raise it.

The owner's 7 Oct decision that a finished-stay fee on an unpaid stay is
"added to the amount owed" routes every pay step through one new home,
`bookingAmountOwedCents` in `booking-payment-state.ts`. Each file below gains
only the call that replaces its own `finalPriceCents - credit` copy (and the
one-line read of the payment's recorded fee it needs); moving the pay steps
themselves is not this change.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 337
reason: its capture-amount check now reads the booking's worth from the one
  home instead of computing price less credit by hand, its mismatch log names
  the amount owed, and its confirmation email quotes the worth (#3955 review).

file: src/app/api/payments/create-payment-intent/route.ts
lines: 905
reason: both amount-owed sites (the in-transaction settle-at-zero check and
  the card intent amount) now read the one home, with the payment's fee read.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 533
reason: the internet-banking amount and its nothing-to-pay check now read the
  one home, with the payment's fee read under the switch's locks.

file: src/lib/payment-reconciliation.ts
lines: 3165
reason: the settle's amount law, payment mirror and capture check read the
  booking's worth from the one home, and the settle posts the fee's CHANGE_FEE
  ledger line beside the confirmation it belongs with.

file: src/lib/stripe-webhook-service.ts
lines: 1842
reason: its capture-amount check reads the booking's worth from the one home,
  skips a capture already recorded for this intent (so a later fee cannot loop
  a redelivery), names the amount owed in its alert, and its confirmation
  email quotes the worth (#3955 review F5, F7, F8).

file: src/lib/xero-booking-invoices.ts
lines: 1599
reason: the primary invoice bills the recorded change fee beside the promo
  lines it already builds, records what it billed before persisting its link
  and hands any gap to xero-primary-invoice-fee-gap.ts, re-runs that check on
  its invoice-already-exists exit so a retry cannot lose the fee, and the
  narration merge skips the fee line (#3955 review X2-X4, round 3). The gap
  logic itself is its own module.

The #3955 review's second round feeds the recorded fee into the remaining pay
steps and the edit lifecycle. Each file below gains only the one-home call at
the decision it already makes, and the line that loads the fee it reads.

file: src/lib/booking-date-modification-service.ts
lines: 2351
reason: the date edit's credit clamp and zero-dollar decision read the
  booking's worth and amount owed, not the bare price (#3955 review F1).

file: src/lib/booking-guest-removal-service.ts
lines: 1483
reason: the shared lifecycle now takes the fee an edit recorded; a removal
  states that it records none.

file: src/lib/cron-confirm-pending.ts
lines: 2055
reason: the saved-card charge, its payment row, its attempt and its alerts
  are sized at the booking's worth through one local helper (#3955 review F2).

file: src/lib/finance-booking-metrics.ts
lines: 1322
reason: a change fee counts as income only once its payment is captured
  (#3955 review F9).

file: src/lib/group-settlement.ts
lines: 1663
reason: the organiser's total and each child's settled payment read the
  child's worth; the children are loaded with the fee their worth needs
  (#3955 review F3).

file: src/lib/member-credit.ts
lines: 1099
reason: the credit clamp is sized to the booking's worth, and its parameter
  says so (#3955 review F1).

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1938
reason: the bank-transfer confirmation email quotes the booking's worth
  (#3955 review F8).
