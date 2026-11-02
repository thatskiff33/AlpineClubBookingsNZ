# File-size allowance for the below-minimum card refusal (#99)

file: src/app/api/payments/create-payment-intent/route.ts
lines: 913
reason: the below-minimum refusal has to sit between the existing-intent
  recovery and the Stripe customer lookup, inside this route's one pay flow,
  so that a captured payment is still recognised and nothing reaches Stripe
  for a refused amount. The rule and its message live in
  `stripe-charge-currency.ts`; the route grows by the one guarded return and
  its comment. Splitting the 900-line route is its own piece of work.
