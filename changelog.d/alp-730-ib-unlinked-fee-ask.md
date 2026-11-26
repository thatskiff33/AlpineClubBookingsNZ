- **A late-notice fee or price increase on a credit-paid Internet Banking
  booking is now asked for before its Xero invoice exists** (#5288). When a
  booking paid in full with account credit (or by bank transfer) has no primary
  Xero invoice yet and an edit makes it cost more, the member's Booking Modified
  email now says "An additional Internet Banking payment of $X is required"
  with the payment reference, as it already did once the invoice existed. The
  edit raises the booking's Xero invoice there and then: it bills the price and
  every change fee, with the account credit allocated against it, so the member
  is billed the increase once. With Xero switched off the email still goes and
  nothing is queued. The booking ledger census (`pnpm run
  payments:audit-booking-ledger`) now lists money owed on a Xero invoice under
  its own heading instead of as money nobody is asking for.
