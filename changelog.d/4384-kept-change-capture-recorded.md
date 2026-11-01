- **A late card payment for a booking change that a treasurer keeps on a
  cancelled booking is now recorded in Xero (#4324).** Before, when the
  booking's Xero invoice existed and no change invoice was waiting on the
  payment, keeping it recorded nothing: Stripe held the money and Xero never
  showed it. The app now records it with the document that matches what Xero
  already bills. Where the booking's invoice already bills the change, or the
  extra invoice the app raised for a change made while that invoice was being
  created does, the payment goes on that invoice, for no more than it still shows due, so the
  invoice is paid off rather than a second invoice counting the same income
  twice. Where nothing in Xero bills the change, the app raises its kept-payment
  invoice, as it does for a kept booking payment; that includes a change whose
  invoice was moved to, and paid by, a later payment, or waits on one. Where a change invoice already
  answers the payment, that invoice records it, as before. Where the payment
  names no booking change, nothing is recorded automatically, even where an
  unpaid invoice names the payment, and the booking-vs-Xero repair tool lists
  it for the treasurer. Each payment is
  recorded once: a repeated Stripe notification, a re-keep after a reopen, or
  the repair tool running beside a keep never records it twice, and refunding a
  reopened payment withdraws a recording that has not been sent. The repair
  tool's dry run now lists payments kept before this fix, with the document
  that will record each, and its apply records them; a payment the treasurer
  already entered by hand in Xero would be recorded again, so check the dry run
  first (see the maintenance guide). And where that extra invoice cannot be
  raised because a kept-payment invoice already bills its change, a Xero
  Operations task (`PRIMARY_INVOICE_UNDERBILLED`) now asks the treasurer to bill
  what is still due, rather than the shortfall going only to the server log.
