- **A card request the background retry set up just as a later booking change
  cancelled it is now withdrawn from Stripe (#4631).** When an extra card
  payment is retried in the background and a later change to the booking nets
  it off or folds it into a newer request at the same moment, the retry's own
  Stripe payment request used to stay open in the club's Stripe account,
  never offered to the member and never paid. It is now cancelled at Stripe,
  just as #4052 does for one set up by the booking change itself. No money
  moves and no operator action is needed.
