# File-size allowances for #3864

A stored credit election must never be spent while the card intent minted at
the pre-election price can still capture, and a full-price capture must never
leave credit spent beside it. Both checks have to sit where the money decision
is made, inside the door that makes it.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 891
reason: the pay step retires the booking's earlier card intent (through the
  helper the Internet Banking switch shares) after its own pre-transaction
  reads and before the transaction that spends the election, refuses with its
  own message when Stripe cannot confirm the cancel, skips the spend for a live
  capture, and re-checks under lock(1) that no other intent is attached before
  spending, answering its own coded 409 for either refusal; the mint key carries
  the amount and currency. Each step reads the request's own booking snapshot
  and response shape, which a helper outside the route would have to take as
  arguments.

file: src/lib/payment-reconciliation.ts
lines: 3126
reason: the settle door gives back applied credit a full-price capture left
  unspent and writes the creditAppliedCents mirror to match, inside the settle
  transaction under the member credit-ledger key it already holds; the Stripe
  settlement source carries the club format the give-back needs, and the
  post-commit report adds the given-back credit to the existing unapplied
  election report. The give-back is asked only when there is excess, and a
  Xero deallocation fence holds that excess for an operator alert instead of
  failing the captured payment.
