# File-size allowances for #3809

A paid booking's price reduction now gives back applied credit, tiered like a
card refund, and a cancellation tiers applied credit capped at what the booking
is worth. The rules live in their own small modules
(`booking-modify-credit-give-back.ts`, `booking-guest-removal-xero.ts`,
`booking-credit-give-back-copy.ts`, and `cancelAppliedCreditBaseCents` beside
`cancelRefundableBaseCents`). What each file below adds is only the wiring that
has to sit where the call, the result or the message already is: the two
pre-transaction values the shared settlement now needs (the club's day and
format, which `INV-LOCK-004` forbids it to read under the locks), the figure
carried out on the door's result, and the line that passes it on.

file: src/lib/booking-batch-modification-service.ts
lines: 2645
reason: passes the club's day and format into the shared settlement, carries
  the credit given back on its result and response, and passes it to this
  door's one Xero dispatch and one "Booking Modified" email.
  Its history row records the settlement of applied credit, which a later
  cancellation caps by (`creditGiveBackHistory`).

file: src/lib/booking-date-modification-service.ts
lines: 2353
reason: the same as the batch door: the settlement's two inputs, the figure on
  its result and response, its Xero dispatch and its two emails.

file: src/lib/booking-guest-removal-service.ts
lines: 1529
reason: passes the club's day and format into the shared settlement and carries
  the credit given back out on the removal's result, for the route's and the
  consent doors' shared Xero leg.

file: src/lib/member-guest-consent-service.ts
lines: 1307
reason: a decline or expiry is a guest removal and now reaches Xero like one;
  the Xero figures travel on the outcome to the one post-commit finaliser this
  file already owns, which queues the shared leg. Moving the finaliser out would
  split the post-commit half of a consent transition across two files.

file: src/lib/email/booking.ts
lines: 1762
reason: the "Booking Modified" sender's flat body composes the credit-given-back
  sentence beside the settlement note; the sentence itself lives in
  `booking-credit-give-back-copy.ts`.

file: src/lib/booking-cancel.ts
lines: 2620
reason: the paid path asks whether the booking was reduced through #3809's
  settlement before it caps the credit (owner decision of 4 Oct 2026) and
  freezes the base on its CANCELLED snapshot; the unpaid branch tiers a
  refunded-whole captured payment's credit (`refundedPaymentCreditRestore`)
  and posts and freezes what it kept. The rules live in their own modules; what
  stays here is the call inside each claim that already owns the restore.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2450
reason: the quote states what saving would give back, from the same figure the
  save computes (`previewPaidReductionCreditGiveBackCents`).

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1717
reason: one line: the guest-add email passes 0 for the credit given back, which
  the sender now requires of every caller.

file: src/lib/xero-booking-repair-classify.ts
lines: 2260
reason: the missing-modification-credit-note finding sizes a credit-paid
  booking's lost note from the give-back its edit's history row records, and
  expects none where the tier gave nothing back; the sizing rule for that
  finding lives only here.
