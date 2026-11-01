- **A card request for released credit that a stalled background retry set up
  is now withdrawn from Stripe once it can never be used (#4652).** When the
  background retry raising a card request for credit used in Xero stalled and
  another retry took over, the stalled one's Stripe payment request used to
  stay open in the club's Stripe account, never offered to the member and
  never paid. Once the retry that took over has finished without it, it is now
  cancelled at Stripe, as #4631 does for an extra card payment's retry, which
  now also covers a stalled retry that another one finished. A request that
  any record names is never cancelled. No money moves and no operator action
  is needed.
