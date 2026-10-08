- **A booking paid entirely with account credit now asks for card payment when a
  change makes it cost more (#3502).** When a member paid for a stay wholly with
  account credit (or a promotion took the whole price off), the booking records
  a $0 payment. If that booking later grew — a guest or a night added, say —
  three of the four ways to change a booking sent the extra to a Xero
  supplementary invoice. At a club without Xero, or before the booking's first
  invoice had been raised, that invoice did not exist, so the member was never
  asked for the money and nothing reported it.

  Every way of changing a booking now asks the member to pay the extra by card,
  the same as the guest-add screen already did, whether or not Xero is
  connected. Where a Xero invoice already exists, the supplementary invoice
  waits for that card payment and records it, so the member is not billed
  twice. If the booking's first Xero invoice is only raised after the card
  payment, that invoice now includes any change fee the card already paid, so
  the card payment and the account credit settle it exactly. No further account credit is taken for the extra.

  Bookings that grew before this fix are not charged retrospectively. The
  read-only booking ledger census (`pnpm run payments:audit-booking-ledger`)
  lists them as owing; see the Maintenance guide before acting on one.

- **A price reduction now cancels or shrinks an unpaid extra payment first
  (#3954).** When a paid booking's price went up, the member was asked for the
  extra by card. If the price then came back down before they paid it, the
  reduction was refunded or credited (or kept, under the club's policy) and the
  card request stayed live, so a member who then paid it left the club holding
  more than the booking cost. Now the reduction comes off the unpaid request
  first: it is cancelled, or replaced by a smaller one, and only what is left is
  refunded, credited or given back under the club's policy. This applies to
  card-paid bookings and to bookings paid with account credit, at every way of
  changing a booking, and the edit screen shows how much comes off the unpaid
  request. A member who pays the old request at the same moment is refunded it
  automatically; reminders stop for a cancelled request and quote the new
  amount for a smaller one. Nothing is sent to Xero for a request that was never
  paid, and the booking-vs-Xero repair tool no longer offers to bill one.

  The same holds when the card request for the increase could not be created at
  the time and was waiting for its automatic retry: the reduction comes off it
  first, and the retry asks only for what the booking still owes, or for nothing.
  A change saved in the few seconds while that retry is running is refused with
  "try again", and goes through on the next save.
