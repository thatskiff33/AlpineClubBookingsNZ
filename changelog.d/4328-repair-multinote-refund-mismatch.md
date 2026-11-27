- **The Xero repair tool no longer reports a false refund-amount mismatch on a
  bank-transfer payment with several refund notes (#4328).** A later hand-back
  or card refund on a bank transfer gets its own Xero credit note, but the
  tool compared the whole refund with the payment's first note alone, so a
  payment whose notes added up correctly was still reported as wrong. An
  officer who "corrected" that note credited the member twice.

  The tool now adds up every live refund note on such a payment and reports a
  mismatch only when together they differ from the payment's cash refund (a
  refund of a late card payment Xero never received is left out), listing each
  note for an officer to check in Xero. A note resolved by hand whose amount
  cannot be read is reported as notes that could not be totalled. It never changes a note itself, and
  `--apply` queues nothing for this finding.
