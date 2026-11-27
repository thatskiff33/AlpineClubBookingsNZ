- **A late-notice fee or price increase on a credit-paid Internet Banking
  booking is now asked for before its Xero invoice exists** (#5288). When a
  booking paid in full with account credit has no primary Xero invoice yet and
  an edit makes it cost more, the member's Booking Modified email now says "An
  additional Internet Banking payment of $X is required" with the payment
  reference, as it already did once the invoice existed. $X is what the
  booking's new Xero invoice will show as due: the price and every change fee
  recorded on the booking, less the account credit already applied. So an
  earlier fee nobody was asked for is asked now, and credit the club kept from
  an earlier reduction is not asked for twice. The edit raises that invoice
  there and then and allocates the credit against it. Xero does not email this
  invoice, because its email would go out before the credit was allocated and
  show the full price; the Booking Modified email is the only ask. A guest
  removal that releases a promotion, and a guest acceptance that reprices the
  booking, are covered the same way. A booking with a bank transfer already
  recorded is left as it was: its increase stays in the census as money nobody
  is asking for, for the treasurer to invoice. With Xero switched off the email
  still goes and nothing is queued, and an edit that settles a booking at $0 no
  longer queues its Xero invoice while Xero is off either. The booking ledger
  census (`pnpm run payments:audit-booking-ledger`) now lists money owed on a
  Xero invoice under its own heading instead of as money nobody is asking for.
