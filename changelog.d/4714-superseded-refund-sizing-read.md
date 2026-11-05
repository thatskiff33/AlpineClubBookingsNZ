- **A refund of a replaced payment no longer asks Stripe for money another
  refund already returned (#4699).** When a member pays a payment request the
  club had already replaced, the payment recovery queue refunds it. If another
  part of the system, such as a cancellation, had refunded some of that payment
  at Stripe but the app had not recorded it yet, the queue asked Stripe for the
  full amount. Stripe refused, and the attempt was retried later, using up one
  of the job's attempts. No money ever moved twice.

  The queue now records what Stripe has already refunded before it works out
  how much to refund, so it asks only for what is left. When nothing is left,
  it closes the job straight away.
