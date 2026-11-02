- **An unused card payment request is now cleaned up when its save fails
  partway, not only when it loses a race (#4676).** When the app asks a member
  to pay more by card, it first creates the payment at Stripe and then saves
  it. If the booking changed in between (a payment cleared, a price reduction
  was made, or the save itself failed), the save is undone and tried again
  later. Before this fix, the Stripe payment created for that attempt was never
  looked at again.

  The app now runs the same check it already runs after a lost race. If the
  request has since been closed without that payment, the payment is cancelled
  at Stripe. Members never saw it, so nothing changes for them. If the request
  is still open, the payment is left alone, because the retry may use it, and
  a `left-open` entry is logged so the club's operator can find it. Do not
  cancel such a payment by hand while its request is still open: a retry can
  ask Stripe for the same payment again and record it as the member's request.
  Retries happen as before.
