- **A card payment for a booking change is now recorded in Xero even when the
  booking's invoice was raised before the member paid (#3953).** If a booking
  was changed before its Xero invoice existed, and the member paid the extra by
  card only after the invoice had gone out, Xero never heard about that
  payment: the invoice showed as part-unpaid although Stripe held the money,
  and the treasurer had to match it by hand.

  Now, when such a payment arrives, the app reads the booking's invoices in
  Xero and records the payment against the one that still has that money due:
  the supplementary invoice raised for a change that landed while the invoice
  was being created (#3980), or otherwise the booking's own invoice, which
  already bills the change. Example: a $300 invoice, a guest added for $80,
  paid by card - Xero shows $380 billed and $380 paid. Each payment is
  recorded once, however many times Stripe or the member's browser report it.

  Each payment is recorded by one document only: if the booking's own invoice
  payment, a supplementary invoice for the change, or the supplementary invoice
  for a change made while the invoice was being raised already records it, the
  app leaves it there.

  Nothing is guessed. If Xero can't be read, the invoice the payment belongs to
  has nothing left due, or the invoice's own payment hasn't been recorded yet,
  the payment is not recorded and the treasurer is emailed - as it is for an
  older payment the app can't tie to a booking change, where another invoice
  on the booking may already record it; the operation in
  **Xero Operations** says why, and **Retry** runs it again once the cause is
  fixed. Payments on cancelled bookings, and on bookings paid by internet
  banking, are not recorded this way.

  A refund of such a payment from Stripe names the invoice it paid on its
  credit note. The booking-vs-Xero repair tool now reports **card payment not
  recorded in Xero** for bookings affected before this change, and can queue
  the fix.
