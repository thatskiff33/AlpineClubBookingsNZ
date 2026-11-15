- **A card refund on a price cut is recorded once in Xero (#3993).**
  Lowering a card-paid booking used to raise a modification credit note against
  an invoice the card had already paid, which Xero refused, and the nightly
  check then raised a second credit for the same refund. The price cut now
  raises the same refund note a cancellation uses, settled from the Stripe
  account. A modification note is not created when the invoice cannot take it,
  and the booking repair tool no longer offers to retry one Xero has already
  refused. If this already happened: keep the refund note, void the unused
  modification note after checking it has no allocations, and Resolve the
  partial operation. Do not void the refund note.
