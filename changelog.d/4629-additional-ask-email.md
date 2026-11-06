- **Booking change emails name the right way to pay an increase (#4052).** A
  card-paid booking whose extra card request could not be set up at once (it is
  retried in the background) was sometimes told to pay by Internet Banking, or
  told nothing at all. Every booking change email now names the extra amount and
  how to pay it by one rule: a card request as a card payment, an Internet
  Banking booking's invoice as an Internet Banking payment.

  A member whose card was declined on an extra payment can still pay that same
  request with another card, and its invoice still waits on it. And a card
  request set up in the moment a later change cancelled it is now withdrawn
  from Stripe, so it no longer clutters the club's Stripe account. No operator
  action is needed.
