- **One-off admin alerts are now rarely lost when the database connection
  drops at the wrong moment (#4696).** Twelve alerts are sent at most once
  ever, such as a held late card payment, a card refund past its charge, or a
  group whose stay started before it was paid. If the app noted it was about to
  send one but the connection dropped before the database confirmed it, that
  note stayed behind and every later run read the alert as already sent.

  Now the app takes back its own note, and only its own, so the next run sends
  the alert once. The alert can still be lost in two rarer cases: the
  connection stays down for both of the app's two immediate attempts to take
  the note back (it logs that it failed), or the database saves the note only
  after the app has already taken it back. A few alerts are raised only at the
  moment something goes wrong, and nothing raises them again; for those the
  error log stays the record. Nothing changes in what the alerts say or who
  receives them.
