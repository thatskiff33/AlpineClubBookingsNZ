- **A kept card payment for a booking change is recorded in Xero even if the
  step after the keep fails (#4382).** When a treasurer keeps a late card
  payment whose change invoice was retired because the payment seemed never to
  come, that invoice is put back in the queue in the same save as the decision.
  The usual Xero sender then records the money. Previously that revival
  happened only after the decision was saved, and a failure there left the
  money in Stripe with nothing in Xero and nobody told.

  A waiting invoice, and a revival the payment does not safely cover, are
  unchanged: those still happen after the decision is saved.
