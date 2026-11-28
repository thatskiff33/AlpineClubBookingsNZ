- **A late-notice fee or price increase on a credit-paid Internet Banking
  booking is now asked for before its Xero invoice exists** (#5288). When a
  booking paid in full with account credit has no primary Xero invoice yet and
  an edit makes it cost more, the member's Booking Modified email now says
  "The amount now due on this booking is $X by Internet Banking. This replaces
  any earlier amount we asked for." with the payment reference. $X is what the
  booking's new Xero invoice will show as due: the price and every change fee
  recorded on the booking, less the account credit already applied. So an
  earlier fee nobody was asked for is asked now, credit the club kept from an
  earlier reduction is not asked for twice, and a member edited twice before
  the invoice links is told the one amount to pay, not two to add up. A
  booking whose invoice is already linked keeps the "An additional Internet
  Banking payment of $X is required" wording, because each of its edits has
  its own invoice. For the credit-paid booking, the edit raises its Xero
  invoice there and then and allocates the credit against it. Xero does not
  email this invoice, because its email would go out before the credit was allocated and
  show the full price; the Booking Modified email is the only ask. A guest
  removal that releases a promotion is covered the same way, and its email now
  carries the payment reference. A booking with a bank transfer already
  recorded is left as it was: its increase stays in the census as money nobody
  is asking for, for the treasurer to invoice. With Xero switched off the email
  still goes and nothing is queued, and an edit that settles a booking at $0 no
  longer queues its Xero invoice while Xero is off either. The booking ledger
  census (`pnpm run payments:audit-booking-ledger`) now lists money owed on a
  Xero invoice under its own heading instead of as money nobody is asking for.
