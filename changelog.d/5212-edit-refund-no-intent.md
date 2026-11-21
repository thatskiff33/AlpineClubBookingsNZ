- **A price cut on a card booking Stripe has no record of is now refunded by
  bank transfer instead of being left owed to a card forever (#5212).** A few
  bookings are recorded as paid by card although Stripe holds no payment to
  refund against. When a date change, a batch edit, a removed guest or a guest
  accepting their place lowered the price of one, the change recorded a card
  refund as owed, but nothing could ever send it, so the member was told a
  refund was on its way that never came.

  Such a change now does what a change to a booking paid by internet banking
  does: it puts one refund task on the **Money to settle** card for the
  treasurer, and the Booking Modified email tells the member the club will
  refund them by bank transfer. No card refund is recorded as owed. Choosing
  account credit is unchanged, and a booking Stripe does hold a payment for is
  refunded to the card as before.

  One limit remains: on most of these bookings the treasurer cannot yet mark
  the task paid back, because there is no card charge on record to set the
  refund against. **Such an open task may already have been paid**, so it can
  look unpaid when it is not: before paying one, check Xero and the club's
  bank account for a refund already sent for that booking. After paying,
  record the refund in Xero against the change's credit note, tell the other
  finance officers (the booking, the amount and the date paid) and your club
  administrator, and leave the task open until #5290 lets you close it.

  Nothing already recorded is changed. If an earlier edit left a card refund
  owed on such a booking, it stays as it was and still needs settling by hand.
