- **A saved card that can never be charged is no longer retried every three
  hours (#3268).** When the automatic charge for a held booking failed, the
  system used to treat every failure the same way: drop the booking back to
  pending, email the administrators, and try the same card again at the next
  run. For a card Stripe had permanently refused — one that had been detached,
  or used up by an earlier one-off payment — that meant the same failure and
  the same alert 24 times over four days, with the member never told.

  The charge failure is now read before anything is retried. A card Stripe
  says cannot be used again, a decline the card issuer marks as final (an
  expired, lost or stolen card, or one that now needs the cardholder present),
  or a card still declining two days after the charge first became due, is
  treated as unusable: it is removed from the booking (and from the booking it
  was borrowed from, for a split guest booking), the member receives one email
  asking them to save a new card, and administrators receive one alert that
  says in plain English what happened and what the member has been asked to
  do. A temporary problem — insufficient funds inside the first two days, or
  Stripe itself being unavailable — is still retried exactly as before.
