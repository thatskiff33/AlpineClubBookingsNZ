- **A card payment on an out-of-date payment can no longer mark a booking paid
  and then be refunded (#4300).** When a booking was edited, the payment the
  member had already started was replaced and queued to be cancelled, or
  refunded if they paid it anyway. Only Stripe's own notification checked for
  that. If the member paid the old payment from a tab still open, and the
  booking's price had come back to its old amount, the payment page, a
  reloaded payment link, or Stripe's notification arriving after the refund was
  queued could mark the booking paid with it. The refund then went through,
  and the booking showed as paid with no money held.

  The booking's settlement now refuses that payment itself, whichever way it
  arrives, including the club's own saved-card charges. The payment goes back
  as before, the booking stays unpaid, and admins are told if it got as far as
  the settlement. A member who has just paid that way on the booking page is
  told the payment will be returned to their card and asked to reload and pay
  the amount the booking shows now; a payer on a payment link sees a notice
  that their earlier payment is going back, beside a fresh payment.
  Neither page offers the out-of-date payment again once the price comes back
  to its amount.
