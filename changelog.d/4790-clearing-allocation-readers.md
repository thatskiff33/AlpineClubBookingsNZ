- **A credit note's allocation repaired by an older version of the repair tool
  now counts straight away in refund totals and the hold-clearing audit
  (#4786).** Since #4767 a cancelled booking's invoice-clearing credit note, or
  a booking edit's credit note, can be closed when an older version of the
  repair tool had already made one of its allocations. Until Xero's next update
  for that note arrived, three places did not see that allocation yet: the
  audit of bank-transfer holds whose invoice was left open, the refunded total
  of a bank-transfer payment, and the invoice corrections counted when such a
  payment is kept at its stored figure.

  They now count it, once, whether the app recorded it as the note's own
  allocation, as the older tool's allocation, or both. Nothing changes in Xero,
  and no stored record is rewritten.
