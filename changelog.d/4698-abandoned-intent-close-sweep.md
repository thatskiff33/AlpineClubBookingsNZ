- **An unused card payment request left open by a failed save is now cleaned
  up once its request ends (#4693).** When the app asks a member to pay more
  by card, it creates the payment at Stripe first and then saves it. If that
  save fails, the request is retried later, and the Stripe payment is kept in
  case the retry uses it. Before this fix, if the retry created a different
  payment instead, or a later price change cancelled or absorbed the request,
  or the request ran out of retries, the first payment stayed open at Stripe
  for good. Members never saw it and could not pay it.

  Now, when a request ends, the app looks at Stripe for the payments it made
  for that request and cancels any that nothing in the app uses. To find them
  it marks each payment it creates with the request it belongs to. Payments
  created before this release, and payments made outside a retry, carry no
  mark and are left alone. Nothing changes for members.
