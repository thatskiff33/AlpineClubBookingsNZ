# File-size allowances for #3916 — the organiser-paid edit refund names the organiser's card

The refund sentence itself lives in the existing copy home,
`src/lib/booking-modified-email-copy.ts` (`bookingModifiedRefundSentence`), so
neither email file gains the wording or its explanation. What remains is the
required flag that carries the settlement's answer to the email: one line at
each `sendBookingModifiedEmail` call site, plus its declaration on the sender.
Comments were compressed to their minimum first. The flag is required, not
optional with a default, for the reason `financialReviewPending` is (#3032): a
default would tell every joiner whose reduction the organiser received that it
went to their own card. Lengths re-measured after merging `main` at `92c73a071`
(epic #3813).

file: src/lib/email/booking.ts
lines: 1791
reason: the sender's required `refundReturnedToOrganiser` field and its
  two-line docblock, plus the argument passed to the copy home. The sender's
  param type is the one every door is checked against, so the field cannot
  live elsewhere.

file: src/lib/booking-date-modification-service.ts
lines: 2337
reason: one line at each of the file's two `sendBookingModifiedEmail` calls
  (the member date change, routed from `result.organiserChildRefund`, and the
  officer date shift, which moves no money and passes false).

file: src/lib/booking-batch-modification-service.ts
lines: 2674
reason: one line at its `sendBookingModifiedEmail` call, routing
  `result.organiserChildRefund !== null`.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 549
reason: one line at its `sendBookingModifiedEmail` call, routing
  `result.organiserChildRefund !== null` from the guest removal's settlement.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1685
reason: one line at its `sendBookingModifiedEmail` call; a guest add never
  refunds, so it passes false.
