- **A card payment that arrives after a stay has ended is handled like one on
  a paid booking (#4285).** When Stripe sent the success of a card payment
  after the booking had moved to completed, the system refused it with an
  error, so Stripe kept retrying it for up to three days and the webhook log
  filled with failures. For the payment that paid for the stay that was only
  noise, but when a member had paid twice (for example from an old browser
  tab), the extra payment was not refunded automatically. Now it is: a repeat
  of the payment that settled the booking is acknowledged and changes nothing,
  and any other card payment is refunded automatically as a duplicate, or kept
  and flagged for an administrator to check when the system has no record of
  which payment settled the booking, just as on a paid booking.

  A card payment that reaches the app for the first time on a paid or
  completed booking that has no other payment holding money and no record of
  which payment settled it (a booking paid with account credit, at a zero
  total or by a group organiser, or one whose earlier payment was refunded) is
  now kept and flagged to the administrators, whatever its amount, rather than
  kept without a word - including a saved-card charge the app records just
  before settling it. A repeat of a payment the app had already recorded is
  still acknowledged quietly. If that alert cannot be sent (or the app stops
  before sending it), it stays owed: the payment's next arrival sends it, and a
  new payments task, "Kept card payment alert", sends it an hour later
  otherwise - about a day later at worst, when the app stopped just after
  claiming that day's alert. That later alert says if the booking was
  cancelled since (naming the cancellation's refund, which may have been
  made as account credit or by hand, and saying a card refund was sent only
  once it was and not after the card company turned it back, a refund to the
  group organiser's card as such, and a part already paid back by bank
  transfer as paid) or another payment now holds money too, and every alert names
  a payment the app no longer counts that still holds money and shows what
  the card payment still holds.
  One case stays quiet: a saved-card charge whose charging request stopped or
  failed between recording the payment and settling it.

  **After upgrading,** run the read-only query in the upgrade notes to list
  completed bookings that may hold a second card payment whose retries ran out
  before the upgrade (or a lone card payment on a booking paid with credit, at
  a zero total or by a group organiser), and check each in Stripe with the
  treasurer. An extra payment found there is refunded by hand in Stripe; the
  app records that refund and queues a Xero credit note, which must be deleted
  or voided in Xero until #4322 is fixed, whether or not its event was resent.
