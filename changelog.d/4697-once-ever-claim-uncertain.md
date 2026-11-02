- **The alert about a Stripe payment the app did not record is no longer lost
  when the database connection drops at the wrong moment (#4679).** If the app
  noted that it was about to send the alert but the connection dropped before
  the database confirmed it, the app mistook its own note for another copy of
  itself already sending, and the alert was never sent.

  Now the app takes that note back and asks Stripe to resend the payment, so
  the alert goes out on the resend. At worst Stripe resends once more than
  needed. Nothing changes in what the alert says or who receives it.
