- **A third card payment on one booking is refunded too (#4211).** When a
  second card payment lands on a booking that is already paid, the club
  refunds it automatically and alerts the admins. But once one such refund
  existed on a booking, any further payment was treated as the one that
  settled it. So when a member paid three times, for example from three old
  browser tabs, the club kept the third payment, with no alert and no task for
  anyone.

  Now every payment after the one that settled the booking is refunded
  automatically, each with its own alert and its own entry in the booking's
  admin history, naming the payment that settled the booking. The payment
  that settled the booking is never refunded, even while an earlier
  duplicate's refund is still waiting to go through. Webhook repeats change
  nothing. This applies from this release: nothing goes back through past
  bookings for a third payment kept before it.
