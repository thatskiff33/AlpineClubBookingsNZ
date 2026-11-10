- **A repaired booking invoice no longer says the club received a card payment
  that was never taken (#4413).** Repairing a price increase used to send the
  extra invoice to Xero as already paid by card, even when the member had not
  paid or was paying by bank transfer. Xero then showed money in the Stripe
  account that Stripe had never taken.

  The repair now follows the same rule as the booking edit itself. An unpaid
  card request waits until the card payment succeeds. A payment already taken
  is recorded. A bank transfer, or an edit with no card payment to point at,
  is raised as unpaid so the treasurer can record the money when it arrives.
