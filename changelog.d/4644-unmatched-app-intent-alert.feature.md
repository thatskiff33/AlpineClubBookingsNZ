- **A booking card payment the app cannot match is no longer silent (#4624).**
  Rarely, a member's card is charged for a booking but the app cannot tie the
  payment to anything it was waiting for on that booking - for example a saved
  card charge whose answer from Stripe was lost. The app used to log it and move
  on, so the booking stayed unpaid, nothing reached Xero, and nobody was told.

  The app now keeps a record of each such payment and sends Finance editors one
  email per payment, "Booking card payment the app could not match - check it",
  naming the amount, the booking, what the app found and the Stripe payment,
  with a link to it in Stripe. It cannot be muted. The booking is not changed;
  the [Payments guide](../docs/guides/payments.md#a-booking-card-payment-the-app-could-not-match)
  says what to do.
