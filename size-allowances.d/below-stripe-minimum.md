# File-size allowances for the below-minimum card refusal (triyder/AlpineClubBookingsNZ#99 and #101)

file: src/app/api/payments/create-payment-intent/route.ts
lines: 920
reason: the below-minimum refusal has to sit between the existing-intent
  recovery and the Stripe customer lookup, inside this route's one pay flow,
  so that a captured payment is still recognised and nothing reaches Stripe
  for a refused amount. The rule and its message live in
  `stripe-charge-currency.ts`; the route grows by the one guarded return and
  its comment. Splitting the 900-line route is its own piece of work.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 675
reason: the refusal has to sit inside this route's claim transaction, on the
  post-lock amount and before the claim and attempt row, and its catch has to
  map the same refusal without a failure alert. The rule and the message live
  in `stripe-charge-currency.ts`. The route grows by one guarded return, one
  response line and one catch mapping. Splitting the route is its own piece of
  work.

file: src/lib/group-settlement.ts
lines: 1684
reason: the refusal has to run twice for a card settlement: on the pre-lock
  total in `createGroupSettlementIntent`, before the children are committed,
  and on the locked total inside `commitChildrenToConfirmed`'s transaction, so
  a refusal rolls back every child it confirmed. A five-line local helper
  keeps the two calls to one line each. Splitting this 1,600-line module is
  its own piece of work.
