# File-size allowances for the below-minimum card refusal on saved-card and group settlement (#101)

file: src/app/api/payments/charge-saved-method/route.ts
lines: 675
reason: the refusal has to sit inside this route's claim transaction, on the
  post-lock amount and before the claim and attempt row, and its catch has to
  map the same refusal without a failure alert. The rule and the message live
  in `stripe-charge-currency.ts`. The route grows by one guarded return, one
  response line and one catch mapping. Splitting the route is its own piece of
  work.

file: src/lib/group-settlement.ts
lines: 1678
reason: the refusal has to run twice in `createGroupSettlementIntent`: on the
  pre-lock total before the children are committed, and on the post-lock total
  before the customer lookup. A five-line local helper keeps the two calls to
  one line each. Splitting this 1,600-line module is its own piece of work.
