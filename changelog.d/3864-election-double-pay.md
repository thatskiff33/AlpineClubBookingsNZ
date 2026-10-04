- **A member who edits a card booking to use their account credit can no longer
  pay twice** (#3864). If the booking already had a card payment started at the
  full price and that payment went through before the member returned to the
  pay page, the pay page spent the credit anyway and then confirmed the
  full-price card payment, so the member paid the whole price by card and lost
  the credit too. The pay page now cancels the earlier card payment before it
  spends the credit; if that payment has already gone through, the booking is
  confirmed at the full price, the credit is left in the member's balance and
  the booking history says so. If Stripe cannot confirm the cancellation the
  pay page asks the member to try again in a few minutes and spends nothing.
  As a backstop, a full-price card payment that lands on a booking whose credit
  was already spent now gives that credit back to the member's balance, and the
  payment record shows the card paid it all. A $200 booking with $50 of credit
  now ends with $200 by card and $50 still available (was $200 by card and $0
  credit). Bookings paid the ordinary way are unchanged.
