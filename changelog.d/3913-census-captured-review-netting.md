- **The cut-over ledger check now understands a review completed after a paid
  booking was cancelled (#3907).** Since #3835, a review completed after a
  cancellation on a booking paid by card or internet banking gives back only
  what is still owed, partly to the card or by bank transfer and partly as
  account credit. The ledger check (`pnpm run booking-ledger:census`) only knew
  the credit part, so it reported every such booking as unexplained and held
  the cut-over, even though the money was right.

  It now checks each of those reviews against the refund that review itself
  made - the card refund it queued, or the bank transfer it recorded - together
  with the credit it gave back. A review whose figures do not add up to the
  cent is still reported, and still holds the cut-over. Nothing about what a
  member is refunded has changed.
