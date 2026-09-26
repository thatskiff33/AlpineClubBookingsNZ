- **A card refund made after an account-credit settlement is no longer lost
  from the payment's refunded total, so a later cancellation cannot pay out
  money already returned (#3640).** A payment's "refunded so far" total counts
  both card refunds and value taken as account credit (for example a removed
  guest). When a card refund came *after* such a credit, the total kept the
  larger of the two figures instead of adding them: a $100 credit followed by a
  $50 card refund showed $100 refunded, not $150. A member who then cancelled in
  a 100% refund tier was paid $300 on top — $450 back against $400 paid — and
  the refund-request screen offered officers $50 of headroom that did not exist.
  Card refunds now add exactly the refund just recorded, whether it was made in
  the app, in the Stripe dashboard, or by the payment-recovery worker, so the
  same sequence totals $150 and the cancellation pays $250. A repeated Stripe
  event adds nothing, and two writers recording refunds at the same moment can
  neither lose nor double one. The Xero credit note for a dashboard refund made
  after a credit is now queued straight away instead of waiting for the daily
  reconciliation to notice it.

  A refund made before the refund ledger existed on your installation is not
  counted a second time when Stripe next lists it. Cancelling a payment whose
  earlier refunds were recorded only in its total can no longer erase a card
  refund that arrives at the same moment.

  Payments that already went through this sequence before the fix keep the
  understated total they have; this change stops new ones. Operators can list
  them, with the amount each is short, with the read-only
  `npm run payments:audit-refunded-total` (see the maintenance guide). It
  repairs nothing.
