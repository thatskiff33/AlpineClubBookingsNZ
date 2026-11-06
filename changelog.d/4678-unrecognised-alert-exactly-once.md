- **The alert about a Stripe payment the app did not record now goes out
  exactly once, even when the database falters for a moment (#4670).** If the
  alert could not be sent and the app then failed to note that, the alert could
  be lost for good; and if the alert was sent but the app failed to note that
  it had been, finance officers could receive it twice.

  Now an alert that was not sent is always tried again when Stripe resends the
  payment, and an alert that was sent is never sent a second time. Nothing
  changes in what the alert says or who receives it.
