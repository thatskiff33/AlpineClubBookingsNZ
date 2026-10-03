# File-size allowances for #3809

A credit-paid booking's price reduction now gives back applied credit, tiered
like a card refund. The rule lives in its own module
(`src/lib/booking-modify-credit-give-back.ts`) and is reached through the
settlement every reduction door already shares (`applyPaymentAdjustments`). What
each door adds is only the two pre-transaction values that settlement now needs
(the club's day and format, which `INV-LOCK-004` forbids it to read under the
locks) and the Xero note's wording (`INV-PAY-101`) carried to the one Xero
dispatch the door already makes. There is no seam that would let those few
lines live anywhere but beside the call and the dispatch they belong to.

file: src/lib/booking-batch-modification-service.ts
lines: 2639
reason: passes the club's day and format into the shared settlement, and
  carries the give-back's note wording from it to this door's Xero dispatch.

file: src/lib/booking-date-modification-service.ts
lines: 2346
reason: passes the club's day and format into the shared settlement, and
  carries the give-back's note wording from it to this door's Xero dispatch.

file: src/lib/booking-guest-removal-service.ts
lines: 1528
reason: passes the club's day and format into the shared settlement, and
  carries the give-back's note wording out on the removal's result for the
  route's Xero dispatch.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 565
reason: one line: the removal's Xero dispatch passes the give-back's note
  wording, so the treasurer reads "account credit" on the note, not a refund.
