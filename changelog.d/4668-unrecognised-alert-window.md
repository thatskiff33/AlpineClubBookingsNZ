- **The alert about a Stripe payment the app did not create, or could not
  match to a booking, now goes out exactly once (#4647).** If the club's mail
  server refused the alert, the app retried it when Stripe sent the payment's
  notification again, and the email retry job could also resend the failed
  copy, so the treasurer could get the same alert twice. Stripe's notification
  is now the only retry.

  A narrower gap is also closed: if the app stopped part-way through handling
  the payment, a later delivery arriving just after the first one was given up
  on could treat the unsent alert as still on its way and never send it.
