- **A paid cancellation no longer refunds a dashboard refund a second time
  (#3793).** If an officer refunded part of a payment in Stripe at the same
  moment the booking was cancelled, the cancellation could work out its refund
  from the payment as it stood just before that refund landed, and pay the
  tier's share of money that had already gone back. It now reads the payment
  only once it holds the payment's lock, so it refunds exactly what it would
  have if the dashboard refund had come first. Nothing else about what a
  cancellation refunds changes.
