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
  the card payment and the account credit settle it exactly. No further account credit is taken for the extra, and price
  reductions on these bookings work exactly as before.

  Bookings that grew before this fix are not charged retrospectively. The
  read-only booking ledger census (`pnpm run payments:audit-booking-ledger`)
  lists them as owing; see the Maintenance guide before acting on one.
