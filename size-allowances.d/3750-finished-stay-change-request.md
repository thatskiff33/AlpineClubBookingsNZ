# File-size allowances for #3750

Approving a locked-period change request on a finished stay executes it
through the canonical batch edit, under one service argument. The executor, its
fee rule, its call guard and the officer's decision handling live in new modules
(`booking-change-request-execution.ts`, `booking-finished-stay-correction.ts`,
`booking-change-request-admin-decision.ts`); only the lines that must sit at the
decision points they change are added to the two files below.

file: src/lib/booking-batch-modification-service.ts
lines: 2890
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
lines: 329
reason: its capture-amount check now reads the booking's worth from the one
  home instead of computing price less credit by hand.

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
lines: 1813
reason: its capture-amount check reads the booking's worth from the one home.

file: src/lib/xero-booking-invoices.ts
lines: 1565
reason: the primary invoice carries the change-fee line for a fee added to an
  uninvoiced booking's amount owed, beside the promo lines it already builds.
