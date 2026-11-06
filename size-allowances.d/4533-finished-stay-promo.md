# File-size allowances for #4533 (a missed promo code on a finished stay)

The finished-stay correction (#3750) gains an officer's promo change. The
promo change's shape, its stored record, its request door and the officer's
card entry each live in new modules (booking-change-request-promo.ts,
booking-change-request-promo-submit.ts, booking-change-request-officer-entry.tsx,
finished-stay-promo-correction-card.tsx). What is left in these three files is
the one place each already decides the thing the promo change touches.

file: src/app/api/bookings/[id]/change-requests/route.ts
lines: 547
reason: the request body's optional promoChange field and the one branch that
  hands it to finishedStayPromoCorrectionRequestResponse before the member's
  structured-change checks run; the door's own refusals and the write live in
  booking-change-request-promo-submit.ts. The branch has to sit in this
  handler, after its authentication, ownership and rate-limit steps.

file: src/components/edit-booking-panel.tsx
lines: 2127
reason: the edit's changes split into the promo code and everything else (so
  the finished-stay card can tell a promo-only edit), the finished-stay flag,
  the card's render beside the other request cards, and Save kept off with the
  price summary hidden on a finished stay. The card itself and its request live
  in edit-booking/finished-stay-promo-correction-card.tsx; these lines read the
  panel's own state, which only the panel holds.

file: src/lib/booking-batch-modification-service.ts
lines: 2754
reason: the finished-stay fee rule is classified with whether the edit changes
  promo codes, and the full-reduction settlement and the untiered give-back
  read the new finishedStayReductionReturnedInFull. The rules live in
  booking-finished-stay-correction.ts; these lines are where the service
  already chooses the settlement and the fee, and must stay beside them.
