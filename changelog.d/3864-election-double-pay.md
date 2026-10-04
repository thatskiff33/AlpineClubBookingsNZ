- **A member who edits a card booking to use their account credit can no longer
  pay twice** (#3864). If the booking already had a card payment started at the
  full price and that payment went through before the member returned to the
  pay page, the pay page spent the credit anyway and then confirmed the
  full-price card payment, so the member paid the whole price by card and lost
  the credit too. The pay page now cancels the earlier card payment before it
  spends the credit; if that payment has already gone through, the booking is
  confirmed at the full price, the credit is left in the member's balance and
  the booking history says so. If Stripe cannot confirm the cancellation, or
  another tab started a card payment at the same moment, the pay page shows
  "Account credit not applied yet" with the reason and asks the member to try
  again; nothing is spent. Two tabs opening the pay page at different amounts
  each get their own card payment instead of an error. As a backstop, a
  full-price card payment that lands on a booking whose credit was already
  spent gives that credit back to the member's balance, the booking history
  says the credit was returned, and the payment record shows the card paid it
  all; if a Xero credit update for that booking is still in progress, the
  booking is confirmed anyway and an administrator is alerted to return the
  credit by hand. A $200 booking with $50 of credit
  now ends with $200 by card and $50 still available (was $200 by card and $0
  credit). Bookings paid the ordinary way are unchanged.
