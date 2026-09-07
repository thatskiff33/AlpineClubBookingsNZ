- **Replacing a saved card no longer leaves the old card chargeable (#3266).**
  When a member with non-member guests started saving a new card for a pending
  booking, the previous card stayed on the booking until the new one was
  confirmed. If they never finished, the club's automatic charge kept trying the
  old — often dead — card, day after day. Starting a replacement now removes the
  old card straight away; a card goes back on the booking only when the new one
  is confirmed.

  Two things follow. If the card on a booking has been retired after a failed
  charge, the booking page shows the **Save Payment Method** card again so the
  member can enter a new one — previously that card disappeared for good once a
  first card had been started. And when the system finds a booking with a
  completed card set-up but no card on file, it asks Stripe whether that card is
  still attached before reusing it, so a card Stripe has already let go is never
  silently put back — including when Stripe's own confirmation of an old card
  set-up arrives late, days after the member has moved on to a new one. No
  operator action is needed.
