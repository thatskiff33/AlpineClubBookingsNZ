- **Groundwork for automatically matching a saved-card payment whose
  confirmation went missing (#4646).** If the app loses Stripe's answer to a
  saved-card charge and the card payment then completes a little later, the
  money is taken but the booking stays unpaid, and treasurers get a "could not
  match an app payment" alert to sort out by hand. This release teaches the app
  to recognise and match charges that tell Stripe which charge attempt they
  belong to. It does not yet send that information on new charges, because the
  previous version of the app, which can still be running during an upgrade or
  after a rollback, would not recognise those charges and could charge the card
  a second time. Until a follow-up release switches it on (#4682), such a
  payment still raises the alert, as before.
