- **A saved-card payment whose confirmation went missing is now matched to its
  booking even when the bank finishes it later.** If the app lost Stripe's
  answer to a saved-card charge and the card payment then completed a little
  later, the money was taken but the booking stayed unpaid and treasurers were
  sent a "could not match an app payment" alert to sort out by hand. Each
  saved-card charge now tells Stripe which charge attempt it belongs to, so the
  booking is marked paid once, automatically. A charge started before this
  update and lost the same way still raises the alert, as before.
