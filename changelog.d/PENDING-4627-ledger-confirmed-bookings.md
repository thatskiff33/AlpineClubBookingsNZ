- **Confirmed bookings now post their charges into the member-money journal
  (Ledger M3b, #4627).** When a booking is confirmed, edited, has a review
  closed or is cancelled, the same booking-ledger lines it already writes are
  posted into the built-in double-entry journal in the same transaction, each
  linked to its line, with an organisation as the debtor for an
  organisation-owned booking. A member merge moves the merged-away member's
  open booking balances to the surviving member. Nothing reads the journal yet,
  so no screen, email, invoice or Xero document changes. Bookings confirmed
  before this release are not posted; a later step back-posts their history.
  `pnpm run booking-ledger:census` gains a `JOURNAL` check that the journal's
  charges add up to the booking-ledger lines it links, and lists any charge line
  left unlinked.
