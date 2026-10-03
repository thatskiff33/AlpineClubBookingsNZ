- **A reduction or cancellation of a booking the group organiser paid for now
  really refunds the organiser (#3653).** When an organiser pays for a whole
  group in one card payment, each joiner's booking had no card payment of its
  own. Reducing a joiner's booking saved the change but refunded nobody, and
  could hand the joiner account credit for money the organiser paid; cancelling
  the group afterwards could then leave that joiner out of the organiser's
  refund.

  Each joiner's refund is now its own refund out of the organiser's combined
  card payment, recorded against that joiner only once Stripe has made it, and
  retried automatically (with an alert if it keeps failing) when Stripe is
  unavailable. A joiner editing their booking sees that any reduction goes back
  to the organiser's card, with no account-credit option; a joiner cancelling
  their own booking is refunded to the organiser's card the same way (including
  after an earlier reduction), and a change that would raise such a booking's
  price is refused with a message to contact the club - shown on the edit
  quote before saving, and also when an officer completes a parked edit's
  review. A group cancellation
  refunds each paid joiner from what is left of their payment after earlier
  refunds, and refunds can never add up to more than the organiser paid. A
  refund Stripe accepts as pending and later fails is noticed by the payments
  cron and owed again, retried once Stripe has forgotten the failed attempt. Groups the organiser settled by Internet Banking are
  unchanged.
  Treasurers can list joiner payments whose refunded figure is not backed by a
  Stripe refund with `pnpm run payments:audit-organiser-child-refunds`; it is
  read-only.

  A refund to the organiser that only succeeds on a retry now leaves a
  `booking.payment.refund_recovered` record in the audit log (category
  `booking`, so the audit-category distribution moves by one booking writer;
  no member-facing change).
